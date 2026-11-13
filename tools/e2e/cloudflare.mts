import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { workerName } from "../../infra/worker-settings.ts";
import { send } from "../ops-check/fetch.mts";
import { HARNESS_REMOTE } from "./github.mts";
import { execute, succeed } from "./process.mts";

const API = "https://api.cloudflare.com/client/v4";

const Named = Schema.Struct({ result: Schema.Array(Schema.Struct({ id: Schema.String })) });

const Applications = Schema.Struct({
  result: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const Namespaces = Schema.Struct({
  result: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const Buckets = Schema.Struct({
  result: Schema.Struct({ buckets: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});

const Subdomain = Schema.Struct({ result: Schema.Struct({ subdomain: Schema.String }) });

const Images = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, tags: Schema.Array(Schema.String) })),
);

export type Account = Readonly<{ token: string; id: string }>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? "";

  if (value === "") throw new Error(`${name} must be set`);

  return value;
}

export function accountFrom(env: NodeJS.ProcessEnv): Account {
  return {
    token: required(env, "CLOUDFLARE_API_TOKEN"),
    id: required(env, "CLOUDFLARE_ACCOUNT_ID"),
  };
}

async function get<S extends Schema.ConstraintDecoder<unknown>>(
  account: Account,
  path: string,
  schema: S,
) {
  const body = await send(account.token, `${API}/accounts/${account.id}${path}`);

  return Schema.decodeUnknownSync(schema)(body);
}

export async function stageUrl(account: Account, stage: string): Promise<string> {
  const { result } = await get(account, "/workers/subdomain", Subdomain);

  return `https://${workerName(stage)}.${result.subdomain}.workers.dev`;
}

export async function deployEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const hasDocker = await execute("sh", ["-c", "command -v docker"]);

  if (hasDocker.code === 0) return env;

  const podman = (await succeed("sh", ["-c", "command -v podman"])).trim();
  const shim = mkdtempSync(join(tmpdir(), "e2e-docker-"));

  symlinkSync(podman, join(shim, "docker"));

  return { ...env, PATH: `${shim}:${env["PATH"] ?? ""}` };
}

export async function deployStage(
  stage: string,
  env: NodeJS.ProcessEnv,
  flags: readonly string[] = [],
): Promise<void> {
  await succeed("pnpm", ["run", "deploy", stage, "--yes", "--no-input", ...flags], {
    env,
    echo: true,
  });
}

async function setSecret(
  stage: string,
  name: string,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await succeed(
    "pnpm",
    [
      "exec",
      "cf",
      "workers",
      "secrets",
      "update",
      name,
      "--worker",
      workerName(stage),
      "--type",
      "secret_text",
    ],
    { env, input: value },
  );
}

async function destroyStage(stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  await succeed(
    "pnpm",
    [
      "alchemy",
      "destroy",
      "--config",
      "infra/alchemy.run.ts",
      "--stage",
      stage,
      "--yes",
      "--no-input",
    ],
    { env, echo: true },
  );
}

function stageImagePrefix(stage: string): string {
  return `cf-stumble-app-${stage}-`;
}

async function stageImages(stage: string, env: NodeJS.ProcessEnv) {
  const listed = await succeed("pnpm", ["--silent", "exec", "cf", "containers", "images", "list"], {
    env,
  });

  return Schema.decodeUnknownSync(Images)(listed).filter((image) =>
    image.name.startsWith(stageImagePrefix(stage)),
  );
}

async function deleteStageImages(stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const image of await stageImages(stage, env)) {
    for (const tag of image.tags) {
      await succeed(
        "pnpm",
        ["exec", "cf", "containers", "images", "delete", `${image.name}:${tag}`, "--force"],
        { env },
      );
    }
  }

  const local = await execute("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], {
    env,
  });

  const tags = local.output
    .split("\n")
    .filter((line) => line.includes(`/${stageImagePrefix(stage)}`));

  if (tags.length > 0) await execute("docker", ["rmi", ...tags], { env });
}

async function stageLeftovers(
  account: Account,
  stage: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const worker = workerName(stage);

  const ours = (name: string) =>
    name === worker || name.startsWith(`${worker}_`) || name.includes(`-${stage}-`);

  const [workers, applications, namespaces, buckets] = await Promise.all([
    get(account, "/workers/scripts", Named),
    get(account, "/containers/applications", Applications),
    get(account, "/workers/durable_objects/namespaces?per_page=1000", Namespaces),
    get(account, "/r2/buckets", Buckets),
  ]);

  const images = await stageImages(stage, env);

  return [
    ...workers.result.map((script) => `worker ${script.id}`),
    ...applications.result.map((application) => `container application ${application.name}`),
    ...namespaces.result.map((namespace) => `durable object namespace ${namespace.name}`),
    ...buckets.result.buckets.map((bucket) => `r2 bucket ${bucket.name}`),
    ...images.map((image) => `image ${image.name}`),
  ].filter((entry) => ours(entry.slice(entry.lastIndexOf(" ") + 1)));
}

export async function deployWithSecrets(
  stage: string,
  password: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await deployStage(stage, env);

  for (const [name, value] of [
    ["HARNESS_REPOSITORY_URL", HARNESS_REMOTE],
    ["GH_TOKEN", env["GH_TOKEN"] ?? ""],
    ["OWNER_PASSWORD", password],
  ] as const) {
    await setSecret(stage, name, value, env);
  }

  await deployStage(stage, env, ["--force"]);
}

export async function destroyAndCheck(stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  await destroyStage(stage, env);
  await deleteStageImages(stage, env);

  const left = await stageLeftovers(accountFrom(env), stage, env);

  if (left.length > 0) throw new Error(`left on the account: ${left.join(", ")}`);
}
