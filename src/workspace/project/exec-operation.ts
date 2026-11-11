import { logEvent, redactedExcerpt } from "../../diagnostics.js";
import {
  isContainerRestartedError,
  type ExecBackend,
  type ExecBackendHandle,
  type ExecBackendInput,
} from "./exec-backend.js";
import { enqueueEvent, enqueueOutput } from "./exec-framing.js";
import { commandProgram } from "./exec-program.js";
import type { ExecBackendChoice, ExecEvent } from "./protocol.js";

export type TerminalEvent = Extract<ExecEvent, { kind: "terminal" }>;

export type SettleListener = (terminal: TerminalEvent) => void;

export interface ExecOperation {
  readonly events: ReadableStream<Uint8Array>;
  requestKill(): void;
}

type Ending = TerminalEvent extends infer Event
  ? Event extends TerminalEvent
    ? Omit<Event, "kind" | "seq">
    : never
  : never;

type BackendRead = Awaited<ReturnType<ExecBackendHandle["reader"]["read"]>>;

const WRITE_FORM_REFUSAL = "the workspace git does not support this form";

const ISOLATE_REFUSED_EXIT_CODE = 129;

function failure(restarted: boolean): Ending {
  return {
    outcome: "failed",
    error: { code: restarted ? "container-restarted" : "backend-unavailable" },
  };
}

function causeText(cause: unknown): string {
  return redactedExcerpt(
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
  );
}

function stopHandle(handle: ExecBackendHandle): void {
  void handle.reader.cancel().catch(() => {});
  void handle.kill().catch(() => {});
}

function startBackendExec(
  execBackend: ExecBackend,
  input: ExecBackendInput,
): Promise<ExecBackendHandle> {
  return new Promise((resolve) => {
    resolve(execBackend.exec(input));
  });
}

class ExecRun implements ExecOperation {
  readonly events: ReadableStream<Uint8Array>;
  readonly #requested: ExecBackendChoice | "automatic";
  readonly #program: string | null;
  readonly #startedAt = Date.now();
  readonly #frames = { seq: 0 };
  readonly #decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  readonly #onSettle: SettleListener;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #started: Promise<void>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #handle: ExecBackendHandle | undefined;
  #settled = false;
  #cause: unknown;
  #writeFormRefused = false;

  constructor(
    execBackend: ExecBackend,
    input: ExecBackendInput,
    onSettle: SettleListener,
    timeoutEndsTurn: boolean,
  ) {
    this.#requested = input.backend ?? "automatic";
    this.#program = commandProgram(input.command);
    this.#onSettle = onSettle;
    this.events = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => this.#pull(),
        cancel: () => {
          this.requestKill();
        },
      },
      { highWaterMark: 1, size: () => 1 },
    );
    this.#timer = setTimeout(() => {
      this.#settle({ outcome: timeoutEndsTurn ? "killed" : "timed-out" });
    }, input.timeoutMs);
    this.#started = startBackendExec(execBackend, input).then(
      (handle) => {
        if (this.#settled) stopHandle(handle);
        else this.#handle = handle;
      },
      (cause) => {
        this.#fail(cause);
      },
    );
  }

  requestKill(): void {
    this.#settle({ outcome: "killed" });
  }

  async #pull(): Promise<void> {
    await this.#started;
    const handle = this.#handle;

    if (this.#settled || handle === undefined) return;

    try {
      const read = await handle.reader.read();

      if (!this.#settled) this.#deliver(read);
    } catch (cause) {
      this.#fail(cause);
    }
  }

  #fail(cause: unknown): void {
    if (!this.#settled) this.#cause = cause;
    this.#settle(failure(isContainerRestartedError(cause)));
  }

  #deliver(read: BackendRead): void {
    const event = read.value;

    if (event !== undefined && event.name !== "exit") {
      const text = this.#decoders[event.name].decode(event.data, { stream: true });

      if (event.name === "stderr" && text.includes(WRITE_FORM_REFUSAL)) {
        this.#writeFormRefused = true;
      }

      enqueueOutput(this.#frames, this.#controller, event.name, text);

      return;
    }

    for (const kind of ["stdout", "stderr"] as const) {
      const tail = this.#decoders[kind].decode();

      if (tail !== "") enqueueOutput(this.#frames, this.#controller, kind, tail);
    }

    this.#settle(
      event === undefined
        ? failure(false)
        : { outcome: "exited", exitCode: event.exitCode, fullOutputPaths: event.fullOutputPaths },
    );
  }

  #settle(ending: Ending): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timer);
    const terminal: TerminalEvent = { kind: "terminal", seq: this.#frames.seq++, ...ending };
    this.#log(terminal);

    try {
      enqueueEvent(this.#controller, terminal);
      this.#controller.close();
    } catch {}

    if (terminal.outcome !== "exited" && this.#handle !== undefined) stopHandle(this.#handle);
    this.#onSettle(terminal);
  }

  #log(terminal: TerminalEvent): void {
    const exitCode = terminal.outcome === "exited" ? terminal.exitCode : null;
    const backend = this.#handle?.backend ?? null;

    logEvent(
      terminal.outcome === "exited" || terminal.outcome === "killed" ? "info" : "warn",
      "exec.finished",
      {
        requested: this.#requested,
        backend,
        program: this.#program,
        durationMs: Date.now() - this.#startedAt,
        outcome: terminal.outcome,
        exitCode,
        fellBackFrom: this.#handle?.fellBackFrom ?? null,
        isolateRefused:
          this.#handle?.isolateRefused === true ||
          (backend === "isolate" && exitCode === ISOLATE_REFUSED_EXIT_CODE),
        writeFormRefused: this.#writeFormRefused,
        errorCode: terminal.outcome === "failed" ? terminal.error.code : null,
        cause: this.#cause === undefined ? null : causeText(this.#cause),
      },
    );
  }
}

export function startExecOperation(
  execBackend: ExecBackend,
  input: ExecBackendInput,
  onSettle: SettleListener,
  timeoutEndsTurn = false,
): ExecOperation {
  return new ExecRun(execBackend, input, onSettle, timeoutEndsTurn);
}
