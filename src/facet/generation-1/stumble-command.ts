import type { Context } from "@earendil-works/chord/context";
import {
  ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
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

const STUMBLE_IN_COMMAND_LIST =
  /(?:^|[;&|(){}`\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*stumble(?=\s|$|[;&|()])/u;

const STUMBLE_ALONE_MESSAGE =
  "stumble runs only as a command on its own, without cd, pipes, redirects or other shell syntax: run `stumble ...` as a separate command.\n";

export function refusesStumbleInCommandList(command: string | readonly string[]): boolean {
  return !isArgv(command) && STUMBLE_IN_COMMAND_LIST.test(command);
}

export function refuseStumbleInCommandList(
  options: ShellExecOptions | undefined,
  context: Context,
): Result<ShellExecResult, ExecutionError> {
  options?.onOutput?.(STUMBLE_ALONE_MESSAGE, context, { stream: "stderr" });

  return { ok: true, value: { exitCode: 2 } };
}

export async function runStumbleCommand(
  args: readonly string[],
  ports: StumblePorts,
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
  if (context.abortSignal?.aborted === true) {
    return { ok: false, error: new ExecutionError("aborted", "aborted") };
  }

  const { stdout, stderr, exitCode } = await runStumble(args, ports);

  if (stdout !== "") options?.onOutput?.(stdout, context, { stream: "stdout" });

  if (stderr !== "") options?.onOutput?.(stderr, context, { stream: "stderr" });

  return { ok: true, value: { exitCode } };
}
