import { logEvent } from "../../diagnostics.js";
import {
  isContainerRestartedError,
  type BackendExecEvent,
  type ExecBackend,
  type ExecBackendHandle,
  type ExecBackendInput,
} from "./exec-backend.js";
import { enqueueEvent, enqueueOutput } from "./exec-framing.js";
import type { ExecBackendChoice, ExecEvent } from "./protocol.js";

type TerminalEvent = Extract<ExecEvent, { kind: "terminal" }>;

export interface ExecOperation {
  readonly events: ReadableStream<Uint8Array>;
  requestKill(): void;
}

interface SettleState {
  readonly requested: ExecBackendChoice | "automatic";
  readonly startedAt: number;
  settled: boolean;
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  handle: ExecBackendHandle | undefined;
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
  onSettle: () => void,
  outcome: TerminalEvent,
  killBackend: boolean,
): void {
  if (state.settled) return;
  state.settled = true;
  logEvent(
    outcome.outcome === "exited" || outcome.outcome === "killed" ? "info" : "warn",
    "exec.finished",
    {
      requested: state.requested,
      backend: state.handle?.backend ?? null,
      durationMs: Date.now() - state.startedAt,
      outcome: outcome.outcome,
      exitCode: outcome.outcome === "exited" ? outcome.exitCode : null,
      fellBackFrom: state.handle?.fellBackFrom ?? null,
      errorCode: outcome.outcome === "failed" ? outcome.error.code : null,
    },
  );

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

  onSettle();
}

function failed(
  state: SettleState,
  code: "backend-unavailable" | "container-restarted" = "backend-unavailable",
): TerminalEvent {
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
  settleWith: (outcome: TerminalEvent, killBackend: boolean) => void,
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
  onSettle: () => void,
): Promise<void> {
  const decoders: Decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  const settleWith = (outcome: TerminalEvent, killBackend: boolean): void => {
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
  onSettle: () => void,
  timeoutMs: number,
  timeoutEndsTurn: boolean,
): void {
  state.timer = setTimeout(() => {
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
  onSettle: () => void,
  timeoutEndsTurn = false,
): ExecOperation {
  const state: SettleState = {
    requested: input.backend ?? "automatic",
    startedAt: Date.now(),
    settled: false,
    seq: 0,
    timer: undefined,
    handle: undefined,
    resumePump: undefined,
  };

  let requestKillImpl: (() => void) | undefined;

  const events = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        armTimeout(state, controller, onSettle, input.timeoutMs, timeoutEndsTurn);
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
    requestKill: () => requestKillImpl?.(),
  };
}
