import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type DispatchJob = "start" | "stop" | "delete" | "wait";

export type DispatchRequest = Readonly<{
  job: DispatchJob;
  container: string;
  egressPort: number;
  env: Readonly<Record<string, string>>;
}>;

export type DispatchResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

const OUTPUT_LIMIT = 4_000;

function envFileText(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")
    .concat("\n");
}

function runScript(script: string, env: NodeJS.ProcessEnv): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export class OrbFailure extends Data.TaggedError("OrbFailure")<{ message: string }> {}

export function attempt<A>(run: () => Promise<A>): Effect.Effect<A, OrbFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new OrbFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
}

export function dispatch(
  script: string,
  request: DispatchRequest,
): Effect.Effect<DispatchResult, OrbFailure> {
  return Effect.acquireUseRelease(
    attempt(() => mkdtemp(join(tmpdir(), "stumble-orb-"))),
    (directory) => {
      const envFile = join(directory, "env");

      return attempt(() => writeFile(envFile, envFileText(request.env), { mode: 0o600 })).pipe(
        Effect.andThen(
          attempt(() =>
            runScript(script, {
              ...process.env,
              STUMBLE_JOB: request.job,
              STUMBLE_CONTAINER: request.container,
              STUMBLE_ENV_FILE: envFile,
              STUMBLE_EGRESS_PORT: String(request.egressPort),
            }),
          ),
        ),
      );
    },
    (directory) => Effect.ignore(attempt(() => rm(directory, { recursive: true, force: true }))),
  );
}

export function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");
}
