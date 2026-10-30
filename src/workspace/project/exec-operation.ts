// oxlint-disable max-lines -- One exec operation owns framing, backend settlement, timeout,
// cancellation, and one terminal event as one stream state machine. Splitting those transitions
// would expose mutable settlement state and weaken the single-terminal-event invariant.

import {
  isContainerRestartedError,
  type BackendExecEvent,
  type ExecBackend,
  type ExecBackendHandle,
  type ExecBackendInput,
} from "./exec-backend.js";
import { MAX_EXEC_FRAME_BYTES, type ExecEvent } from "./protocol.js";

type ExecKillReason = "manual" | "end-turn" | "turn-end";

export type ExecSettlement = Readonly<{
  outcome: Extract<ExecEvent, { kind: "terminal" }>["outcome"];
  exitCode: number | null;
  errorCode: "backend-unavailable" | "container-restarted" | null;
  durationMs: number;
  endedBy: ExecKillReason | null;
}>;

export interface ExecOperation {
  readonly events: ReadableStream<Uint8Array>;
  requestKill(reason?: ExecKillReason): void;
}

interface SettleState {
  settled: boolean;
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  handle: ExecBackendHandle | undefined;
  readonly startedAt: number;
  killReason: ExecKillReason | null;
  resumePump: (() => void) | undefined;
}

const encoder = new TextEncoder();

function encodeEvent(event: ExecEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function enqueueEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: ExecEvent,
): void {
  const frame = encodeEvent(event);

  if (frame.byteLength > MAX_EXEC_FRAME_BYTES) {
    throw new Error("exec event exceeds the protocol frame limit");
  }

  controller.enqueue(frame);
}

function largestFrameEnd(
  kind: "stdout" | "stderr",
  data: string,
  start: number,
  seq: number,
): number {
  let low = start + 1;
  let high = data.length;
  let result = start;

  while (low <= high) {
    let middle = Math.floor((low + high) / 2);

    if (middle > start && isHighSurrogate(data.codePointAt(middle - 1) ?? 0)) middle -= 1;

    if (middle <= start) {
      low = start + 1;
      continue;
    }

    const frame = encodeEvent({ kind, seq, data: data.slice(start, middle) });

    if (frame.byteLength <= MAX_EXEC_FRAME_BYTES) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (result === start) throw new Error("exec frame limit cannot encode one character");

  return result;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function enqueueOutput(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  kind: "stdout" | "stderr",
  data: string,
): void {
  if (data === "") {
    enqueueEvent(controller, { kind, seq: state.seq++, data });

    return;
  }

  for (let start = 0; start < data.length;) {
    const end = largestFrameEnd(kind, data, start, state.seq);
    enqueueEvent(controller, { kind, seq: state.seq++, data: data.slice(start, end) });
    start = end;
  }
}

function resumePump(state: SettleState): void {
  const resume = state.resumePump;
  state.resumePump = undefined;
  resume?.();
}

/**
 * Publishes exactly one terminal event; whichever cause settles first wins. `killBackend` is
 * fire-and-forget so a hanging or rejecting backend kill can never block or reject this operation.
 * A handle that has not arrived yet is killed by `disposeLateHandle`.
 */
function settle(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  onSettle: (settlement: ExecSettlement) => void,
  outcome: ExecEvent,
  killBackend: boolean,
): void {
  if (state.settled) return;
  state.settled = true;

  if (state.timer !== undefined) clearTimeout(state.timer);
  resumePump(state);

  try {
    enqueueEvent(controller, outcome);
    controller.close();
  } catch {
    // The consumer already cancelled the stream; the terminal outcome still counts as sent.
  }

  if (killBackend && state.handle !== undefined) {
    void state.handle.reader.cancel().catch(() => {});
    void state.handle.kill().catch(() => {});
  }

  const terminal = outcome.kind === "terminal" ? outcome : undefined;
  onSettle({
    outcome: terminal?.outcome ?? "failed",
    exitCode: terminal?.outcome === "exited" ? terminal.exitCode : null,
    errorCode: terminal?.outcome === "failed" ? terminal.error.code : null,
    durationMs: Math.max(0, Date.now() - state.startedAt),
    endedBy:
      terminal?.outcome === "killed" || terminal?.outcome === "timed-out" ? state.killReason : null,
  });
}

function failed(
  state: SettleState,
  code: "backend-unavailable" | "container-restarted" = "backend-unavailable",
): ExecEvent {
  return {
    kind: "terminal",
    seq: state.seq++,
    outcome: "failed",
    error: { code },
  };
}

/** The handle is only ever killed once, whether inline in `settle` or here for a late arrival. */
function disposeLateHandle(handle: ExecBackendHandle): void {
  void handle.reader.cancel().catch(() => {});
  void handle.kill().catch(() => {});
}

interface Decoders {
  stdout: TextDecoder;
  stderr: TextDecoder;
}

/**
 * Run only when the backend itself ends the stream; a kill, timeout, or failed read settles at
 * once and drops pending bytes.
 */
function flushDecoders(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  decoders: Decoders,
): void {
  for (const kind of ["stdout", "stderr"] as const) {
    const tail = decoders[kind].decode();

    if (tail !== "") enqueueOutput(state, controller, kind, tail);
  }
}

function applyBackendRead(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  settleWith: (outcome: ExecEvent, killBackend: boolean) => void,
  decoders: Decoders,
  read: { done: false; value: BackendExecEvent } | { done: true },
): boolean {
  if (read.done) {
    flushDecoders(state, controller, decoders);
    settleWith(failed(state), true);

    return true;
  }

  const { value } = read;

  if (value.name === "stdout") {
    enqueueOutput(
      state,
      controller,
      "stdout",
      decoders.stdout.decode(value.data, { stream: true }),
    );

    return false;
  }

  if (value.name === "stderr") {
    enqueueOutput(
      state,
      controller,
      "stderr",
      decoders.stderr.decode(value.data, { stream: true }),
    );

    return false;
  }

  flushDecoders(state, controller, decoders);
  settleWith(
    { kind: "terminal", seq: state.seq++, outcome: "exited", exitCode: value.exitCode },
    false,
  );

  return true;
}

function waitForDemand(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const desiredSize = controller.desiredSize;

  if (desiredSize !== null && desiredSize > 0) return Promise.resolve();

  return new Promise((resolve) => {
    state.resumePump = resolve;
  });
}

async function pumpBackendEvents(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  handle: ExecBackendHandle,
  onSettle: (settlement: ExecSettlement) => void,
): Promise<void> {
  const decoders: Decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  const settleWith = (outcome: ExecEvent, killBackend: boolean): void => {
    settle(state, controller, onSettle, outcome, killBackend);
  };

  try {
    while (!state.settled) {
      await waitForDemand(state, controller);

      if (state.settled) return;
      const read = await handle.reader.read();

      if (state.settled) return;

      if (applyBackendRead(state, controller, settleWith, decoders, read)) return;
    }
  } catch (error) {
    settleWith(
      failed(
        state,
        isContainerRestartedError(error) ? "container-restarted" : "backend-unavailable",
      ),
      true,
    );
  }
}

/** A synchronous throw becomes a rejection, so a backend that throws is handled like one that rejects. */
function startBackendExec(
  execBackend: ExecBackend,
  input: ExecBackendInput,
): Promise<ExecBackendHandle> {
  try {
    return Promise.resolve(execBackend.exec(input));
  } catch (error) {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Forwards whatever `execBackend.exec()` threw, the same shape a native rejection from it would carry.
    return Promise.reject(error);
  }
}

/** A timeout that stands for the turn's deadline is the turn ending, so it settles as `killed` by `turn-end`. */
function armTimeout(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  onSettle: (settlement: ExecSettlement) => void,
  timeoutMs: number,
  timeoutEndsTurn: boolean,
): void {
  state.timer = setTimeout(() => {
    if (timeoutEndsTurn) state.killReason = "turn-end";
    settle(
      state,
      controller,
      onSettle,
      { kind: "terminal", seq: state.seq++, outcome: timeoutEndsTurn ? "killed" : "timed-out" },
      true,
    );
  }, timeoutMs);
}

function watchBackendExec(
  state: SettleState,
  controller: ReadableStreamDefaultController<Uint8Array>,
  execBackend: ExecBackend,
  input: ExecBackendInput,
  onSettle: (settlement: ExecSettlement) => void,
): void {
  startBackendExec(execBackend, input).then(
    (handle) => {
      if (state.settled) {
        disposeLateHandle(handle);

        return;
      }

      state.handle = handle;
      void pumpBackendEvents(state, controller, handle, onSettle);
    },
    (error) => {
      settle(
        state,
        controller,
        onSettle,
        failed(
          state,
          isContainerRestartedError(error) ? "container-restarted" : "backend-unavailable",
        ),
        false,
      );
    },
  );
}

/**
 * One terminal event per command; every later trigger is a no-op. The host timeout is armed before
 * `execBackend.exec()` is awaited, so a backend that never resolves its handle is still bounded by
 * `timeoutMs`. A timeout or kill cancels the backend reader before awaiting `handle.kill()`.
 * `onSettle` runs synchronously with the terminal event so the caller can drop its references.
 * `timeoutEndsTurn` marks a `timeoutMs` capped at the turn's deadline.
 */
export function startExecOperation(
  execBackend: ExecBackend,
  input: ExecBackendInput,
  onSettle: (settlement: ExecSettlement) => void,
  timeoutEndsTurn = false,
): ExecOperation {
  const state: SettleState = {
    settled: false,
    seq: 0,
    timer: undefined,
    handle: undefined,
    startedAt: Date.now(),
    killReason: null,
    resumePump: undefined,
  };

  let requestKillImpl: ((reason?: ExecKillReason) => void) | undefined;

  const events = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        armTimeout(state, controller, onSettle, input.timeoutMs, timeoutEndsTurn);
        requestKillImpl = (reason = "manual") => {
          state.killReason = reason;
          settle(
            state,
            controller,
            onSettle,
            { kind: "terminal", seq: state.seq++, outcome: "killed" },
            true,
          );
        };

        watchBackendExec(state, controller, execBackend, input, onSettle);
      },
      pull() {
        resumePump(state);
      },
      cancel() {
        requestKillImpl?.();
      },
    },
    { highWaterMark: 1, size: () => 1 },
  );

  return {
    events,
    requestKill: (reason) => requestKillImpl?.(reason),
  };
}
