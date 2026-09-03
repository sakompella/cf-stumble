import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";
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
  /** Set once `execBackend.exec()` resolves and this operation is still unsettled. */
  handle: ExecBackendHandle | undefined;
}

/**
 * Publishes exactly one terminal event and closes the stream. Every later call, from any trigger,
 * is a no-op: whichever cause settles first wins the race. If the backend handle has arrived by
 * the time this runs, `killBackend` fires a fire-and-forget `handle.kill()` so a hanging or
 * rejecting backend kill can never block or reject this operation. If the handle has not arrived
 * yet, there is nothing to kill here; `disposeLateHandle` kills it once it shows up instead.
 */
function settle(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
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
  if (killBackend && state.handle !== undefined) {
    void state.handle.reader.cancel().catch(() => {});
    void state.handle.kill().catch(() => {});
  }
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

/**
 * Kills and disposes a backend handle that resolved after this operation already settled (by
 * timeout, manual kill, or a start rejection). Nothing was ever enqueued for it and nothing is
 * enqueued here; the handle is only ever killed once, whether that happens inline in `settle` or,
 * for a handle that arrives late, here.
 */
function disposeLateHandle(handle: ExecBackendHandle): void {
  void handle.reader.cancel().catch(() => {});
  void handle.kill().catch(() => {});
}

interface Decoders {
  stdout: TextDecoder;
  stderr: TextDecoder;
}

/** Applies one backend read result. Returns `true` once the operation has reached a terminal outcome. */
function applyBackendRead(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  settleWith: (outcome: ExecEvent, killBackend: boolean) => void,
  decoders: Decoders,
  read: { done: false; value: BackendExecEvent } | { done: true },
): boolean {
  if (read.done) {
    settleWith(failed(state), false);
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
  settleWith(
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
  const settleWith = (outcome: ExecEvent, killBackend: boolean): void => {
    settle(state, controller, onSettle, outcome, killBackend);
  };

  try {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `state.settled` is set inside `settle`, called from this same loop and from the timeout/kill triggers below.
    while (!state.settled) {
      // oxlint-disable-next-line no-await-in-loop -- Each read must observe `state.settled` before the next.
      const read = await handle.reader.read();
      if (state.settled) return;
      if (applyBackendRead(state, controller, settleWith, decoders, read)) return;
    }
  } catch {
    settleWith(failed(state), false);
  }
}

/**
 * Invokes `execBackend.exec()`, converting a synchronous throw into a rejected promise so a
 * misbehaving backend is handled identically whether it throws or rejects.
 */
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

/** Arms the host timeout: whichever of timeout, manual kill, or backend settlement fires first wins. */
function armTimeout(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  onSettle: () => void,
  timeoutMs: number,
): void {
  state.timer = setTimeout(() => {
    settle(
      state,
      controller,
      onSettle,
      { kind: "terminal", seq: state.seq++, outcome: "timed-out" },
      true,
    );
  }, timeoutMs);
}

/**
 * Starts `execBackend.exec()` without awaiting it and wires its eventual settlement: a handle
 * that arrives before this operation has settled starts the pump loop; one that arrives after is
 * disposed without emitting anything; a rejection before settlement is one failed terminal event.
 */
function watchBackendExec(
  state: SettleState,
  controller: ReadableStreamDefaultController<ExecEvent>,
  execBackend: ExecBackend,
  input: ExecBackendInput,
  onSettle: () => void,
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
    () => {
      settle(state, controller, onSettle, failed(state), false);
    },
  );
}

/**
 * Runs one command's lifecycle to exactly one terminal event: exit wins with its code; a manual
 * kill or timeout emits `killed`/`timed-out`; a closed stream that never produced an exit event,
 * a failed read, or a rejected `execBackend.exec()` call emits `failed`. Whichever of these
 * settles first wins the race and every later trigger — including a late event still in flight
 * from the backend reader, or a backend handle that resolves after the operation already settled
 * — becomes a no-op that never emits a second event.
 *
 * The operation identity (this function's return value, including its event stream) is produced
 * synchronously and its host timeout timer is armed before `execBackend.exec()` is ever awaited,
 * so a backend that never resolves its handle still leaves the operation bounded by `timeoutMs`.
 * If the timeout or a manual kill wins that race, the eventual handle — if `exec()` ever settles
 * — is killed and disposed the moment it arrives, without emitting anything else.
 *
 * A timeout or manual kill emits its terminal event and cancels the backend reader before ever
 * awaiting `handle.kill()`; the kill call itself is fire-and-forget so a hanging or rejecting
 * backend kill can never block or reject this operation. `onSettle` runs synchronously with the
 * terminal event so the caller can drop its own references (map entry, timer) the instant the
 * operation ends.
 */
export function startExecOperation(
  execBackend: ExecBackend,
  input: ExecBackendInput,
  onSettle: () => void,
): ExecOperation {
  const state: SettleState = { settled: false, seq: 0, timer: undefined, handle: undefined };
  let requestKillImpl: (() => void) | undefined;

  const events = new ReadableStream<ExecEvent>({
    start(controller) {
      armTimeout(state, controller, onSettle, input.timeoutMs);
      requestKillImpl = () => {
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
  });

  return {
    events,
    requestKill: () => requestKillImpl?.(),
  };
}
