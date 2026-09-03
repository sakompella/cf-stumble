import type { BackendExecEvent, ExecBackendHandle } from "./exec-backend.js";
import type { ExecEvent } from "./types.js";

export interface ExecOperation {
  readonly events: ReadableStream<ExecEvent>;
  /** Requests a manual kill. A no-op once the operation has already reached a terminal outcome. */
  requestKill(): void;
}

interface SettleState {
  settled: boolean;
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Publishes exactly one terminal event and closes the stream. Every later call, from any trigger,
 * is a no-op: whichever cause settles first wins the race. `killBackend` fires a fire-and-forget
 * `handle.kill()` so a hanging or rejecting backend kill can never block or reject this operation.
 */
function settleOperation(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  handle: ExecBackendHandle,
  onSettle: () => void,
  outcome: ExecEvent,
  killBackend: boolean,
): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timer !== undefined) clearTimeout(state.timer);
  try {
    controller.enqueue(outcome);
    controller.close();
  } catch {
    // The consumer already cancelled the stream; the terminal outcome still counts as sent.
  }
  void handle.reader.cancel().catch(() => {});
  if (killBackend) void handle.kill().catch(() => {});
  onSettle();
}

function failed(state: SettleState): ExecEvent {
  return {
    kind: "terminal",
    seq: state.seq++,
    outcome: "failed",
    error: { code: "backend-unavailable" },
  };
}

interface Decoders {
  stdout: TextDecoder;
  stderr: TextDecoder;
}

/** Applies one backend read result. Returns `true` once the operation has reached a terminal outcome. */
function applyBackendRead(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  settle: (outcome: ExecEvent, killBackend: boolean) => void,
  decoders: Decoders,
  read: { done: false; value: BackendExecEvent } | { done: true },
): boolean {
  if (read.done) {
    settle(failed(state), false);
    return true;
  }
  const { value } = read;
  if (value.name === "stdout") {
    controller.enqueue({
      kind: "stdout",
      seq: state.seq++,
      data: decoders.stdout.decode(value.data, { stream: true }),
    });
    return false;
  }
  if (value.name === "stderr") {
    controller.enqueue({
      kind: "stderr",
      seq: state.seq++,
      data: decoders.stderr.decode(value.data, { stream: true }),
    });
    return false;
  }
  settle(
    { kind: "terminal", seq: state.seq++, outcome: "exited", exitCode: value.exitCode },
    false,
  );
  return true;
}

/** Pumps backend events onto the stream until a terminal outcome settles it or it is cancelled. */
async function pumpBackendEvents(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  handle: ExecBackendHandle,
  onSettle: () => void,
): Promise<void> {
  const decoders: Decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const settle = (outcome: ExecEvent, killBackend: boolean): void => {
    settleOperation(state, controller, handle, onSettle, outcome, killBackend);
  };

  try {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `state.settled` is set inside `settleOperation`, called from this same loop and from the timeout/kill triggers below.
    while (!state.settled) {
      // oxlint-disable-next-line no-await-in-loop -- Each read must observe `state.settled` before the next.
      const read = await handle.reader.read();
      if (state.settled) return;
      if (applyBackendRead(state, controller, settle, decoders, read)) return;
    }
  } catch {
    settle(failed(state), false);
  }
}

/**
 * Runs one command's lifecycle to exactly one terminal event: exit wins with its code; a manual
 * kill or timeout emits `killed`/`timed-out`; a closed stream that never produced an exit event,
 * or a failed read, emits `failed`. Whichever of these settles first wins the race and every later
 * trigger — including a late event still in flight from the backend reader — becomes a no-op.
 *
 * A timeout emits its terminal event and cancels the backend reader before ever awaiting
 * `handle.kill()`; the kill call itself is fire-and-forget so a hanging or rejecting backend kill
 * can never block or reject this operation. `onSettle` runs synchronously with the terminal event
 * so the caller can drop its own references (map entry, timer) the instant the operation ends.
 */
export function startExecOperation(
  handle: ExecBackendHandle,
  timeoutMs: number,
  onSettle: () => void,
): ExecOperation {
  const state: SettleState = { settled: false, seq: 0, timer: undefined };
  let requestKillImpl: (() => void) | undefined;

  const events = new ReadableStream<ExecEvent>({
    start(controller) {
      state.timer = setTimeout(() => {
        settleOperation(
          state,
          controller,
          handle,
          onSettle,
          { kind: "terminal", seq: state.seq++, outcome: "timed-out" },
          true,
        );
      }, timeoutMs);

      requestKillImpl = () => {
        settleOperation(
          state,
          controller,
          handle,
          onSettle,
          { kind: "terminal", seq: state.seq++, outcome: "killed" },
          true,
        );
      };

      void pumpBackendEvents(state, controller, handle, onSettle);
    },
  });

  return {
    events,
    requestKill: () => requestKillImpl?.(),
  };
}
