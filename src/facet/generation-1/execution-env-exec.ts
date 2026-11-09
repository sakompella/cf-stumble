import type { Context } from "@earendil-works/chord/context";
import {
  ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { shellQuote } from "../../shell-quote.js";
import { MAX_EXEC_TIMEOUT_MS, type ExecEvent } from "../../workspace/project/protocol.js";
import { NdjsonFrameReader } from "./execution-env-frame-reader.js";
import {
  resolveInWorkspace,
  fromAddressed,
  type ComputerWorkspace,
} from "./execution-env-paths.js";
import { OutputSpill } from "./execution-env-spill.js";

type ExecResult = Result<ShellExecResult, ExecutionError>;

type Terminal = Extract<ExecEvent, { kind: "terminal" }>;

type Output = Extract<ExecEvent, { kind: "stdout" | "stderr" }>;

export type RunningCommands = Set<string>;

function failure(code: ExecutionError["code"], message: string): ExecResult {
  return { ok: false, error: new ExecutionError(code, message) };
}

function isAborted(context: Context): boolean {
  return context.abortSignal?.aborted === true;
}

export function isArgv(command: string | readonly string[]): command is readonly string[] {
  return typeof command !== "string";
}

function scriptOf(command: string | readonly string[], options: ShellExecOptions | undefined) {
  const variables = Object.entries(options?.env ?? {}).map(([key, value]) => `${key}=${value}`);
  const clearsEnv = options?.inheritEnv === false;
  const changesEnv = variables.length > 0 || clearsEnv;

  if (!isArgv(command) && !changesEnv) return command;

  const argv = isArgv(command) ? command : ["/bin/sh", "-c", command];
  const env = changesEnv ? ["env", ...(clearsEnv ? ["-i"] : []), ...variables] : [];

  return `exec ${[...env, ...argv].map((part) => shellQuote(part)).join(" ")}`;
}

function isSavedPaths(value: unknown): value is readonly string[] | undefined {
  if (value === undefined) return true;

  if (!Array.isArray(value)) return false;

  return value.every((path): path is string => typeof path === "string");
}

function isExecEvent(value: unknown): value is ExecEvent {
  if (typeof value !== "object" || value === null) return false;

  if (!("seq" in value) || typeof value.seq !== "number" || !("kind" in value)) return false;

  if (value.kind === "stdout" || value.kind === "stderr") {
    return "data" in value && typeof value.data === "string";
  }

  if (value.kind !== "terminal" || !("outcome" in value)) return false;

  if (value.outcome === "exited") {
    const saved = "fullOutputPaths" in value ? value.fullOutputPaths : undefined;

    return "exitCode" in value && typeof value.exitCode === "number" && isSavedPaths(saved);
  }

  if (value.outcome === "failed") {
    const error = "error" in value ? value.error : undefined;

    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
    );
  }

  return value.outcome === "killed" || value.outcome === "timed-out";
}

async function nextEvent(frames: NdjsonFrameReader): Promise<ExecEvent | ExecutionError> {
  const frame = await frames.next();

  if (frame.kind === "eof") {
    return new ExecutionError("unknown", "the exec stream ended without a terminal event");
  }

  if (frame.kind !== "value") return new ExecutionError("unknown", "the exec stream broke");

  return isExecEvent(frame.value)
    ? frame.value
    : new ExecutionError("unknown", "the capability sent a malformed exec event");
}

function fullOutputPath(terminal: Terminal): string | undefined {
  const paths = terminal.outcome === "exited" ? (terminal.fullOutputPaths ?? []) : [];
  const first = paths[0];

  return first === undefined ? undefined : fromAddressed(first).absolute;
}

function exitedResult(
  terminal: Extract<Terminal, { outcome: "exited" }>,
  argv: boolean,
  spillPath: string | undefined,
): ExecResult {
  if (argv && (terminal.exitCode === 126 || terminal.exitCode === 127)) {
    return failure("spawn_error", `the program could not run (exit ${terminal.exitCode})`);
  }

  const value: ShellExecResult = { exitCode: terminal.exitCode };

  if (spillPath !== undefined) value.spillPath = spillPath;

  return { ok: true, value };
}

function unexited(
  terminal: Exclude<Terminal, { outcome: "exited" }>,
  context: Context,
): ExecutionError {
  switch (terminal.outcome) {
    case "timed-out":
      return new ExecutionError("timeout", "the command timed out");
    case "killed":
      return isAborted(context)
        ? new ExecutionError("aborted", "aborted")
        : new ExecutionError("unknown", "the command ended without exiting: killed");
    case "failed":
      return isAborted(context)
        ? new ExecutionError("aborted", "aborted")
        : new ExecutionError("unknown", `the command failed: ${terminal.error.code}`);
    default: {
      const exhaustive: never = terminal;

      return exhaustive;
    }
  }
}

function settledResult(
  terminal: Terminal,
  argv: boolean,
  spillPath: string | undefined,
  context: Context,
): ExecResult {
  if (terminal.outcome === "exited") return exitedResult(terminal, argv, spillPath);

  const error = unexited(terminal, context);

  if (spillPath !== undefined) error.spillPath = spillPath;

  return { ok: false, error };
}

function deliver(
  event: Output,
  options: ShellExecOptions | undefined,
  context: Context,
): Result<void, ExecutionError> {
  try {
    options?.onOutput?.(event.data, context, { stream: event.kind });

    return { ok: true, value: undefined };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;

    return {
      ok: false,
      error: new ExecutionError("callback_error", "an output callback threw", cause),
    };
  }
}

interface RunningCommand {
  readonly workspace: ComputerWorkspace;
  readonly operationId: string;
  readonly frames: NdjsonFrameReader;
  readonly argv: boolean;
  readonly options: ShellExecOptions | undefined;
  readonly context: Context;
}

async function settle(command: RunningCommand): Promise<ExecResult> {
  const { workspace, operationId, frames, options, context } = command;

  const spill =
    options?.spill === undefined ? undefined : new OutputSpill(workspace, options.spill, context);

  const stop = (error: ExecutionError): ExecResult => {
    frames.cancel();
    void workspace.target.kill(operationId).catch(() => {});

    return { ok: false, error };
  };

  for (;;) {
    const event = await nextEvent(frames);

    if (event instanceof ExecutionError) return stop(event);

    if (event.kind === "terminal") {
      const spilled = await spill?.finish();

      if (spilled?.ok === false) return stop(spilled.error);

      return settledResult(event, command.argv, spilled?.value ?? fullOutputPath(event), context);
    }

    if (event.data === "") continue;

    const delivered = deliver(event, options, context);

    if (!delivered.ok) return stop(delivered.error);

    const spilled = await spill?.push(event.data);

    if (spilled?.ok === false) return stop(spilled.error);
  }
}

export async function execInWorkspace(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
): Promise<ExecResult> {
  const signal = context.abortSignal;

  if (isAborted(context)) return failure("aborted", "aborted");

  if (isArgv(command) && command.length === 0) return failure("spawn_error", "Empty argv");

  const timeout = options?.timeout ?? MAX_EXEC_TIMEOUT_MS / 1_000;

  if (!Number.isFinite(timeout) || timeout <= 0) {
    return failure("timeout", "Invalid timeout: must be a finite number of seconds");
  }

  const cwd = resolveInWorkspace(workspace.cwd, options?.cwd ?? workspace.cwd);

  if (!cwd.ok) return failure("spawn_error", cwd.error.message);

  const input = {
    command: scriptOf(command, options),
    cwd: cwd.value.addressed,
    timeoutMs: Math.min(timeout * 1_000, MAX_EXEC_TIMEOUT_MS),
    backend: workspace.backend,
  };

  const started = await workspace.target.startExec(input).catch(() => {});

  if (started === undefined) return failure("unknown", "startExec rejected");

  if (!started.ok) return failure("spawn_error", `startExec refused: ${started.error.code}`);

  const { operationId, events } = started.value;

  const kill = (): void => {
    void workspace.target.kill(operationId).catch(() => {});
  };

  const frames = new NdjsonFrameReader(events.getReader());

  running.add(operationId);
  signal?.addEventListener("abort", kill);

  if (isAborted(context)) kill();

  try {
    return await settle({
      workspace,
      operationId,
      frames,
      argv: isArgv(command),
      options,
      context,
    });
  } finally {
    signal?.removeEventListener("abort", kill);
    running.delete(operationId);
  }
}

export async function killAll(workspace: ComputerWorkspace, running: RunningCommands) {
  const kills = [...running].map((operationId) => workspace.target.kill(operationId));

  await Promise.allSettled(kills);
}
