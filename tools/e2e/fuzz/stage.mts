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
  opsCheck: boolean;
}>;

export type FuzzRun = Readonly<{
  runId: string;
  seed: number;
  minutes: number;
  owner: Owner;
  github: GitHub;
  password: string;
  signal: AbortSignal;
  target: Target;
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

export async function withStage(
  area: string,
  options: FuzzOptions,
  work: (run: FuzzRun) => Promise<boolean>,
): Promise<boolean> {
  const runId = randomBytes(4).toString("hex");
  const password = process.env["E2E_OWNER_PASSWORD"] ?? randomBytes(24).toString("base64url");
  const interrupted = new AbortController();
  let cleaning = false;

  const target = new Target({
    runId,
    url: undefined,
    stage: options.stage,
    stagePrefix: `fz${area}`,
    password,
    env: process.env,
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(
      `fuzz: ${signal}, ${cleaning ? "cleanup continues" : "stopping, then cleaning up"}`,
    );

    if (cleaning) return;

    interrupted.abort(new Error(signal));
    stopChildren();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

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
      password,
      signal: interrupted.signal,
      target,
    });
  } catch (cause) {
    report(cause);
  }

  cleaning = true;

  return (await finish(target, owner, options, password, runId)) && passed;
}

async function finish(
  target: Target,
  owner: Owner | undefined,
  options: FuzzOptions,
  password: string,
  runId: string,
): Promise<boolean> {
  const checked =
    owner === undefined || !options.opsCheck
      ? true
      : await attempt("ops:check", () => target.checkOps());

  if (options.keep) {
    const file = join(tmpdir(), `cf-stumble-fuzz-${runId}-password`);

    writeFileSync(file, password, { mode: 0o600 });
    console.error(`fuzz: kept ${owner?.url ?? "the stage"}; password in ${file}`);

    return checked;
  }

  const branches = await attempt("delete branches", () => target.deleteBranches());

  const closed = await attempt(target.fresh ? "destroy" : "restore", () =>
    target.fresh ? target.destroy() : target.restore(),
  );

  return checked && branches && closed;
}
