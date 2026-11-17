import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

export type Finished = Readonly<{ code: number; output: string }>;

type RunOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  input?: string;
  echo?: boolean;
}>;

const KILL_GRACE_MS = 10_000;

const stepSignal = new AsyncLocalStorage<AbortSignal>();

export function withSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return stepSignal.run(signal, work);
}

const outsideSteps = new AbortController().signal;

export function currentSignal(): AbortSignal {
  return stepSignal.getStore() ?? outsideSteps;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
  }
}

export function execute(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Finished> {
  const signal = currentSignal();

  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const chunks: string[] = [];

    const collect = (chunk: Buffer) => {
      chunks.push(chunk.toString());

      if (options.echo === true) process.stderr.write(chunk);
    };

    let force: NodeJS.Timeout | undefined;

    const stop = () => {
      signalGroup(child, "SIGTERM");
      force = setTimeout(() => {
        signalGroup(child, "SIGKILL");
      }, KILL_GRACE_MS);
    };

    const release = () => {
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
    };

    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (cause) => {
      release();
      reject(cause);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      release();

      if (signal.aborted) reject(new Error(`stopped: ${String(signal.reason)}`));
      else resolve({ code: code ?? 1, output: chunks.join("") });
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function succeed(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const finished = await execute(command, args, options);

  if (finished.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${finished.code}: ${finished.output.slice(-2000)}`,
    );
  }

  return finished.output;
}
