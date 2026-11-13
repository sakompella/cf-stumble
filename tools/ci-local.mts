import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { PRODUCTION_STAGE, workerName } from "../infra/worker-settings.ts";
import {
  accountFrom,
  deployEnv,
  deployStage,
  deployWithSecrets,
  destroyAndCheck,
  stageUrl,
} from "./e2e/cloudflare.mts";
import { execute, succeed } from "./e2e/process.mts";
import { MINUTE_MS, Steps } from "./e2e/steps.mts";
import { readToken, resolveAccount } from "./ops-check/fetch.mts";

const PREVIEW_STAGE = "preview";

const { values } = parseArgs({ options: { stage: { type: "string" } } });

const stage = values.stage ?? PREVIEW_STAGE;

const throwaway = stage !== PREVIEW_STAGE;

if (stage === PRODUCTION_STAGE) throw new Error("ci:local destroys a --stage it deploys; not prod");

const runId = `local${randomBytes(3).toString("hex")}`;

const steps = new Steps();

async function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const finished = await execute(command, args, { env, echo: true });

  if (finished.code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${finished.code}`);
}

async function localEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await deployEnv(process.env);
  const gh = env["GH_TOKEN"] ?? (await succeed("gh", ["auth", "token"])).trim();

  const browser = existsSync(chromium.executablePath())
    ? undefined
    : (env["CHROMIUM_PATH"] ?? (await succeed("sh", ["-c", "command -v chromium"])).trim());

  return { ...env, GH_TOKEN: gh, ...(browser !== undefined && { CHROMIUM_PATH: browser }) };
}

async function withCloudflare(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const given = process.env["CLOUDFLARE_API_TOKEN"];
  const { CLOUDFLARE_API_TOKEN: _stale, ...login } = env;

  if (given === undefined) await succeed("pnpm", ["exec", "cf", "auth", "whoami"], { env: login });

  const token = given ?? readToken(login);

  return {
    ...login,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: await resolveAccount(token, login),
  };
}

async function previewPassword(): Promise<string> {
  const common = (
    await succeed("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();

  return readFileSync(join(dirname(common), ".audit/local/preview-owner-password"), "utf8").trim();
}

async function workspaceImage(env: NodeJS.ProcessEnv): Promise<void> {
  const ref = (await succeed("infra/workspace-image/image-ref.sh", [])).trim();
  const pulled = await execute("docker", ["pull", "--platform", "linux/amd64", ref], { env });

  if (pulled.code === 0) {
    console.error(`ci:local: ${ref} is on the registry`);

    return;
  }

  await run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      "infra/workspace-image/computerd.Dockerfile",
      "-t",
      ref,
      "infra/workspace-image",
    ],
    env,
  );
}

async function release(env: NodeJS.ProcessEnv, password: string): Promise<void> {
  const cloudflare = await withCloudflare(env);

  await run("pnpm", ["exec", "tsx", "tools/release-generation.mts", "--force"], {
    ...cloudflare,
    STUMBLE_URL: await stageUrl(accountFrom(cloudflare), stage),
    TARGET_SHA: (await succeed("git", ["rev-parse", "HEAD"])).trim(),
    OWNER_PASSWORD: password,
  });
}

async function deploy(env: NodeJS.ProcessEnv, password: string): Promise<void> {
  const cloudflare = await withCloudflare(env);

  await (throwaway
    ? deployWithSecrets(stage, password, cloudflare)
    : deployStage(stage, cloudflare));
}

async function e2e(env: NodeJS.ProcessEnv, password: string): Promise<void> {
  await run("pnpm", ["e2e", "--stage", stage, "--keep", "--run-id", runId], {
    ...(await withCloudflare(env)),
    E2E_OWNER_PASSWORD: password,
  });
}

async function opsCheck(env: NodeJS.ProcessEnv): Promise<void> {
  await run(
    "pnpm",
    ["exec", "tsx", "tools/ops-check/run.mts", "--worker", workerName(stage), "--since", "2h"],
    await withCloudflare(env),
  );
}

async function pushedHead(): Promise<void> {
  const head = (await succeed("git", ["rev-parse", "HEAD"])).trim();

  if ((await succeed("git", ["branch", "-r", "--contains", head])).trim() === "") {
    throw new Error(`push ${head} first: the stage's harness fetches it from GitHub`);
  }
}

async function main(): Promise<void> {
  let env = process.env;
  let password = "";

  console.error(
    `ci:local: run ${runId}, stage ${stage}${throwaway ? ", destroyed at the end" : ""}`,
  );

  const ready = await steps.run("set up", 2 * MINUTE_MS, async () => {
    await pushedHead();
    env = await localEnv();
    password = throwaway ? randomBytes(24).toString("base64url") : await previewPassword();
  });

  const verified =
    ready &&
    (await steps.run("verify", 30 * MINUTE_MS, () =>
      run("nix", ["develop", "-c", "pnpm", "verify"], env),
    ));

  const built =
    verified && (await steps.run("workspace image", 30 * MINUTE_MS, () => workspaceImage(env)));

  const deployed =
    built && (await steps.run("deploy", 25 * MINUTE_MS, () => deploy(env, password)));

  const released =
    deployed &&
    (await steps.run("release generation", 25 * MINUTE_MS, () => release(env, password)));

  if (released) await steps.run("e2e", 90 * MINUTE_MS, () => e2e(env, password));

  if (deployed) await steps.run("ops:check", 5 * MINUTE_MS, () => opsCheck(env));

  steps.startCleanup();

  if (throwaway && built) {
    await steps.run("destroy the stage", 15 * MINUTE_MS, async () => {
      await destroyAndCheck(stage, await withCloudflare(env));
    });
  }
}

await main().catch((cause: unknown) => {
  console.error(cause);
});

process.exitCode = steps.report(`ci:local run ${runId}`) ? 0 : 1;
