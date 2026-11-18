import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export type Finished = Readonly<{ code: number; output: string }>;

type RunOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  input?: string;
  echo?: boolean;
}>;

const KILL_GRACE_MS = 10_000;

const GROUP_POLL_MS = 100;

const stepSignal = new AsyncLocalStorage<AbortSignal>();

export function withSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return stepSignal.run(signal, work);
}

const outsideSteps = new AbortController().signal;

export function currentSignal(): AbortSignal {
  return stepSignal.getStore() ?? outsideSteps;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;

  try {
    process.kill(-child.pid, signal);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;

    throw cause;
  }
}

async function groupEmptied(child: ChildProcess): Promise<void> {
  while (signalGroup(child, 0)) await sleep(GROUP_POLL_MS);
}

export async function execute(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Finished> {
  const signal = currentSignal();

  signal.throwIfAborted();

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

  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.stdin.on("error", () => {});

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(options.input ?? "");
    });

    if (signal.aborted) {
      await groupEmptied(child);

      throw new Error(`stopped: ${String(signal.reason)}`);
    }

    return { code: code ?? 1, output: chunks.join("") };
  } finally {
    clearTimeout(force);
    signal.removeEventListener("abort", stop);
  }
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
