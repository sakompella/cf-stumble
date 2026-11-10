import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHub } from "../github.mts";
import type { Owner } from "../owner-api.mts";
import { stopChildren } from "../process.mts";
import { Target } from "../target.mts";

export type FuzzOptions = Readonly<{
  seed: number;
  minutes: number;
  stage: string | undefined;
  keep: boolean;
}>;

export type FuzzRun = Readonly<{
  runId: string;
  seed: number;
  minutes: number;
  owner: Owner;
  github: GitHub;
  token: string;
  signal: AbortSignal;
}>;

function report(cause: unknown): void {
  console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
}

async function attempt(name: string, work: () => Promise<void>): Promise<boolean> {
  try {
    await work();

    return true;
  } catch (cause) {
    console.error(`fuzz: ${name} failed`);
    report(cause);

    return false;
  }
}

function keepPassword(runId: string, password: string, url: string | undefined): void {
  const file = join(tmpdir(), `cf-stumble-fuzz-${runId}-password`);

  writeFileSync(file, password, { mode: 0o600 });
  console.error(`fuzz: kept ${url ?? "the stage"}; password in ${file}`);
}

async function cleanUp(target: Target, owner: Owner | undefined): Promise<boolean> {
  const checked = owner === undefined ? true : await attempt("ops:check", () => target.checkOps());
  const branches = await attempt("delete branches", () => target.deleteBranches());

  const closed = await attempt(target.fresh ? "destroy" : "restore", () =>
    target.fresh ? target.destroy() : target.restore(),
  );

  return checked && branches && closed;
}

function stopOnSignals() {
  const controller = new AbortController();
  let cleaning = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(
      `fuzz: ${signal}, ${cleaning ? "cleanup continues" : "stopping, then cleaning up"}`,
    );

    if (cleaning) return;

    controller.abort(new Error(signal));
    stopChildren();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    controller,
    cleaning: () => {
      cleaning = true;
    },
  };
}

export async function withStage(
  area: string,
  options: FuzzOptions,
  work: (run: FuzzRun) => Promise<boolean>,
): Promise<boolean> {
  const runId = randomBytes(4).toString("hex");
  const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");
  const { controller, cleaning } = stopOnSignals();

  const target = new Target({
    runId,
    url: undefined,
    stage: options.stage,
    stagePrefix: `fz${area}`,
    password,
    env: process.env,
  });

  console.error(`fuzz: ${area} run ${runId}, seed ${options.seed}, stage ${target.stage ?? "?"}`);

  let passed = false;
  let owner: Owner | undefined;

  try {
    owner = await target.deploy();
    passed = await work({
      runId,
      seed: options.seed,
      minutes: options.minutes,
      owner,
      github: target.github,
      token: process.env["GH_TOKEN"] ?? "",
      signal: controller.signal,
    });
  } catch (cause) {
    report(cause);
  }

  cleaning();

  if (options.keep) {
    keepPassword(runId, password, owner?.url);

    return passed && (owner === undefined || (await attempt("ops:check", () => target.checkOps())));
  }

  return (await cleanUp(target, owner)) && passed;
}
