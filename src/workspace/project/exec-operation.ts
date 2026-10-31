import {
  isContainerRestartedError,
  type BackendExecEvent,
  type ExecBackend,
  type ExecBackendHandle,
  type ExecBackendInput,
} from "./exec-backend.js";
import { enqueueEvent, enqueueOutput } from "./exec-framing.js";
import type { ExecEvent } from "./protocol.js";

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

function resumePump(state: SettleState): void {
  const resume = state.resumePump;
  state.resumePump = undefined;
  resume?.();
}

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
  } catch {}

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

function disposeLateHandle(handle: ExecBackendHandle): void {
  void handle.reader.cancel().catch(() => {});
  void handle.kill().catch(() => {});
}

interface Decoders {
  stdout: TextDecoder;
  stderr: TextDecoder;
}

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
  } catch (cause) {
    settleWith(
      failed(
        state,
        isContainerRestartedError(cause) ? "container-restarted" : "backend-unavailable",
      ),
      true,
    );
  }
}

function startBackendExec(
  execBackend: ExecBackend,
  input: ExecBackendInput,
): Promise<ExecBackendHandle> {
  return new Promise((resolve) => {
    resolve(execBackend.exec(input));
  });
}

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
    (cause) => {
      settle(
        state,
        controller,
        onSettle,
        failed(
          state,
          isContainerRestartedError(cause) ? "container-restarted" : "backend-unavailable",
        ),
        false,
      );
    },
  );
}

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
