import { spawn, type ChildProcess } from "node:child_process";

export type Finished = Readonly<{ code: number; output: string }>;

type RunOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  input?: string;
  echo?: boolean;
}>;

const running = new Set<ChildProcess>();

export function stopChildren(): void {
  for (const child of running) child.kill("SIGTERM");
}

export function execute(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: string[] = [];

    const collect = (chunk: Buffer) => {
      chunks.push(chunk.toString());

      if (options.echo === true) process.stderr.write(chunk);
    };

    running.add(child);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      running.delete(child);
      resolve({ code: code ?? 1, output: chunks.join("") });
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
