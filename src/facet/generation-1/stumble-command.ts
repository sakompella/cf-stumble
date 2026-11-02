import type { Context } from "@earendil-works/chord/context";
import type {
  ExecutionError,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { runStumble, type StumblePorts } from "../../stumble-cli/index.js";
import { isArgv } from "./execution-env-exec.js";

const PLAIN_STUMBLE_COMMAND = /^\s*stumble(?:\s+[\w.:@,+/-]+)*\s*$/u;

export function stumbleArguments(
  command: string | readonly string[],
): readonly string[] | undefined {
  if (isArgv(command)) return command[0] === "stumble" ? command.slice(1) : undefined;

  return PLAIN_STUMBLE_COMMAND.test(command) ? command.trim().split(/\s+/u).slice(1) : undefined;
}

export async function runStumbleCommand(
  args: readonly string[],
  ports: StumblePorts,
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
  const { stdout, stderr, exitCode } = await runStumble(args, ports);

  if (stdout !== "") options?.onOutput?.(stdout, context, { stream: "stdout" });

  if (stderr !== "") options?.onOutput?.(stderr, context, { stream: "stderr" });

  return { ok: true, value: { exitCode } };
}
