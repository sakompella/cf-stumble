import { ExecutionError, truncateTail } from "@cf-stumble/pi";
import type { Result, ShellExecOptions } from "@cf-stumble/pi";
import {
  MAX_EXEC_TIMEOUT_MS,
  type ProjectRpcTargetContract,
} from "../../workspace/project/protocol.js";
import { NdjsonFrameReader } from "./execution-env-frame-reader.js";
import { resolveAbsolute, toAddressedPath } from "./execution-env-paths.js";
import { isStartExecValue, parseEnvelope, parseExecEvent } from "./execution-env-rpc.js";
import type { ParsedExecEvent, StartExecValue } from "./execution-env-rpc.js";

type ExecResult = Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>;

/** The narrow slice of the project RPC target `exec` needs: nothing here can read or write a file. */
export type ExecTarget = Pick<ProjectRpcTargetContract, "startExec" | "kill">;

type MutableExecState = { aborted: boolean; stdout: string; stderr: string };

type Decoders = { readonly stdout: TextDecoder; readonly stderr: TextDecoder };

type StepOutcome = { readonly done: true; readonly result: ExecResult } | { readonly done: false };

function isOptionAborted(options: ShellExecOptions | undefined): boolean {
  return options?.abortSignal !== undefined && options.abortSignal.aborted;
}

function hasEnvOverride(options: ShellExecOptions | undefined): boolean {
  if (options?.inheritEnv === false) return true;

  return options?.env !== undefined && Object.keys(options.env).length > 0;
}

/** Converts Pi's optional timeout in seconds to milliseconds, clamped to the target's own maximum. */
function timeoutMsFrom(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  const ms = Math.round(timeoutSeconds * 1_000);

  return Math.min(Math.max(ms, 1), MAX_EXEC_TIMEOUT_MS);
}

function requestKill(target: ExecTarget, operationId: string): void {
  void target.kill(operationId).catch(() => {});
}

function stopAbnormalStream(
  target: ExecTarget,
  operationId: string,
  frames: NdjsonFrameReader,
): void {
  frames.cancel();
  requestKill(target, operationId);
}

/**
 * Normalizes one channel's event payload to text, decoding bytes with a persistent streaming
 * decoder so a multi-byte UTF-8 sequence split across events still decodes correctly. Returns
 * `undefined` for a payload that is neither a string nor bytes: a malformed event.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: an exec event's payload is untrusted until this decodes it.
function decodeChannel(decoder: TextDecoder, data: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: narrowing an untrusted exec event payload.
  if (typeof data === "string") return data;

  if (data instanceof Uint8Array) return decoder.decode(data, { stream: true });

  return undefined;
}

function malformedEventResult(): ExecResult {
  return {
    ok: false,
    error: new ExecutionError("unknown", "the project target sent a malformed exec event"),
  };
}

function handleChannelEvent(
  target: ExecTarget,
  operationId: string,
  frames: NdjsonFrameReader,
  event: Extract<ParsedExecEvent, { kind: "stdout" | "stderr" }>,
  decoders: Decoders,
  state: MutableExecState,
  options: ShellExecOptions | undefined,
): StepOutcome {
  const decoder = event.kind === "stdout" ? decoders.stdout : decoders.stderr;
  const text = decodeChannel(decoder, event.data);

  if (text === undefined) {
    stopAbnormalStream(target, operationId, frames);

    return { done: true, result: malformedEventResult() };
  }

  if (event.kind === "stdout") state.stdout = truncateTail(state.stdout + text).content;
  else state.stderr = truncateTail(state.stderr + text).content;
  const callback = event.kind === "stdout" ? options?.onStdout : options?.onStderr;

  try {
    callback?.(text);
  } catch (error) {
    stopAbnormalStream(target, operationId, frames);
    const cause = error instanceof Error ? error : undefined;

    return {
      done: true,
      result: {
        ok: false,
        error: new ExecutionError("callback_error", "an exec output callback threw", cause),
      },
    };
  }

  return { done: false };
}

function terminalResult(
  event: Extract<ParsedExecEvent, { kind: "terminal" }>,
  aborted: boolean,
  stdout: string,
  stderr: string,
): ExecResult {
  if (event.outcome === "exited")
    return { ok: true, value: { stdout, stderr, exitCode: event.exitCode } };

  if (event.outcome === "timed-out")
    return { ok: false, error: new ExecutionError("timeout", "the command timed out") };

  if (event.outcome === "killed") {
    return {
      ok: false,
      error: aborted
        ? new ExecutionError("aborted", "the command was aborted")
        : new ExecutionError("unknown", "the command was killed for an unexplained reason"),
    };
  }

  return {
    ok: false,
    error: new ExecutionError("unknown", "the backend command execution failed"),
  };
}

async function readNextEvent(
  target: ExecTarget,
  operationId: string,
  frames: NdjsonFrameReader,
  decoders: Decoders,
  state: MutableExecState,
  options: ShellExecOptions | undefined,
): Promise<StepOutcome> {
  const frame = await frames.next();

  if (state.aborted) {
    return {
      done: true,
      result: { ok: false, error: new ExecutionError("aborted", "the command was aborted") },
    };
  }

  if (frame.kind === "stream-error") {
    stopAbnormalStream(target, operationId, frames);

    return {
      done: true,
      result: { ok: false, error: new ExecutionError("unknown", "the exec event stream rejected") },
    };
  }

  if (frame.kind === "eof") {
    stopAbnormalStream(target, operationId, frames);
    const message = "the exec event stream ended without a terminal event";

    return { done: true, result: { ok: false, error: new ExecutionError("unknown", message) } };
  }

  if (frame.kind === "malformed") {
    stopAbnormalStream(target, operationId, frames);

    return { done: true, result: malformedEventResult() };
  }

  const event = parseExecEvent(frame.value);

  if (event === undefined) {
    stopAbnormalStream(target, operationId, frames);

    return { done: true, result: malformedEventResult() };
  }

  if (event.kind === "stdout" || event.kind === "stderr") {
    return handleChannelEvent(target, operationId, frames, event, decoders, state, options);
  }

  return {
    done: true,
    result: terminalResult(event, state.aborted, state.stdout, state.stderr),
  };
}

async function consumeExecStream(
  target: ExecTarget,
  started: StartExecValue,
  options: ShellExecOptions | undefined,
): Promise<ExecResult> {
  const { operationId, events } = started;
  const state: MutableExecState = { aborted: false, stdout: "", stderr: "" };
  const frames = new NdjsonFrameReader(events.getReader());

  const onAbort = (): void => {
    state.aborted = true;
    stopAbnormalStream(target, operationId, frames);
  };

  options?.abortSignal?.addEventListener("abort", onAbort);

  const decoders: Decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Each event must be handled before the next is read.
      const outcome = await readNextEvent(target, operationId, frames, decoders, state, options);

      if (outcome.done) return outcome.result;
    }
  } finally {
    options?.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function startExecInput(command: string, addressedCwd: string, timeoutMs: number | undefined) {
  return timeoutMs === undefined
    ? { command, cwd: addressedCwd }
    : { command, cwd: addressedCwd, timeoutMs };
}

function startExecFailure(code: string): ExecResult {
  const message =
    code === "too-many-operations"
      ? "startExec failed: too many operations are already running"
      : `startExec failed: ${code}`;

  return { ok: false, error: new ExecutionError("spawn_error", message) };
}

/**
 * Implements Pi's `Shell.exec` against the six-method project RPC target: starts the command,
 * decodes its `ReadableStream<Uint8Array>` of newline-delimited JSON frames back into events with
 * `NdjsonFrameReader`, invokes Pi's `onStdout`/`onStderr` callbacks before the terminal event
 * resolves this call, and never throws or rejects. An environment override this target cannot
 * honor, an already-aborted signal, a malformed target response, a truncated byte frame, or a
 * rejected RPC call all resolve to a typed `ExecutionError` instead.
 */
export async function execViaProjectTarget(
  cwd: string,
  target: ExecTarget,
  command: string,
  options?: ShellExecOptions,
): Promise<ExecResult> {
  if (isOptionAborted(options)) {
    return {
      ok: false,
      error: new ExecutionError("aborted", "the abort signal was already aborted"),
    };
  }

  if (hasEnvOverride(options)) {
    const message = "environment overrides are not supported by the project target";

    return { ok: false, error: new ExecutionError("unknown", message) };
  }

  const resolvedCwd = resolveAbsolute(cwd, options?.cwd ?? cwd);

  if (!resolvedCwd.ok)
    return { ok: false, error: new ExecutionError("spawn_error", resolvedCwd.error.message) };

  const input = startExecInput(
    command,
    toAddressedPath(resolvedCwd.value),
    timeoutMsFrom(options?.timeout),
  );

  let started: unknown;

  try {
    started = await target.startExec(input);
  } catch {
    return { ok: false, error: new ExecutionError("unknown", "startExec rejected") };
  }

  const envelope = parseEnvelope(started, isStartExecValue);

  if (envelope.kind === "malformed") {
    return {
      ok: false,
      error: new ExecutionError("unknown", "startExec returned a malformed response"),
    };
  }

  if (envelope.kind === "failure") return startExecFailure(envelope.error.code);

  return consumeExecStream(target, envelope.value, options);
}
