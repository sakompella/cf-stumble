import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  parseFacetFrameLine,
  TURN_PROGRESS_FRAME_MAX_BYTES,
  TURN_TERMINAL_FRAME_MAX_BYTES,
  type ProjectTurnFrame,
} from "./turn-frames.js";
import { endTurn, releaseLease, type StreamEnding, type TurnSettlement } from "./turn-settle.js";
import { runResponseBody } from "../../run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "../../stream-keepalive.js";
import type { TurnBound } from "./turn-bound.js";
import type { TurnWorkspace } from "./project-turn.js";
import { logLeaseAbandoned, TurnStreamLog, type DroppedFrame, type TurnTrace } from "./turn-log.js";

type ReadTurnStreamInput = TurnSettlement &
  Readonly<{
    frames: ReadableStream<Uint8Array>;
    bound: TurnBound;
    workspace: TurnWorkspace;
    trace: TurnTrace;
  }>;

const encoder = new TextEncoder();

function encodeFrame(frame: ProjectTurnFrame): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

type Publish = (frame: ProjectTurnFrame) => void;

type Drop = (reason: DroppedFrame) => void;

const CANCELLED: StreamEnding = { kind: "cancelled" };

const TIMED_OUT: StreamEnding = { kind: "timed-out" };

const MALFORMED: StreamEnding = { kind: "invalid", problem: "malformed-frame" };

const MISSING_TERMINAL: StreamEnding = { kind: "invalid", problem: "missing-terminal-frame" };

const OVERSIZED: StreamEnding = { kind: "invalid", problem: "oversized-frame" };

const NEWLINE = 0x0a;

/**
 * Every frame is proved here before any byte reaches a client, and the ending is decided from what
 * this loop saw, not from what a client received.
 */
class TurnReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #publish: Publish;
  readonly #drop: Drop;
  readonly #decoder = new TextDecoder();
  /**
   * Lines are split on the newline byte, which never occurs inside a multi-byte UTF-8 character, so
   * each line is measured in bytes before it is decoded.
   */
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;

  constructor(frames: ReadableStream<Uint8Array>, publish: Publish, drop: Drop) {
    this.#reader = frames.getReader();
    this.#publish = publish;
    this.#drop = drop;
  }

  /**
   * Stops at the terminal frame and never reads what follows, so a second terminal frame cannot
   * save a second conversation. The caller cancels the reader afterwards, so a generation that goes
   * quiet after its terminal frame cannot hold the project until the deadline.
   */
  read(): Effect.Effect<StreamEnding> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const chunk = yield* Effect.promise(() =>
          this.#reader.read().then(
            (read) => read,
            () => null,
          ),
        );

        // A disconnect and the deadline interrupt this read before they cancel the stream, so a
        // read that rejects here was rejected by the generation's side: bad input.
        if (chunk === null) return MALFORMED;

        if (chunk.done) return MISSING_TERMINAL;

        const ending = this.#consume(chunk.value);

        if (ending !== undefined) return ending;
      }
    });
  }

  /** The acknowledgement comes from mutable code and may never arrive, so it is not awaited. */
  stop(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#reader.cancel().catch(() => {});
    });
  }

  #consume(chunk: Uint8Array): StreamEnding | undefined {
    let start = 0;

    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);

      if (newline < 0) {
        return this.#hold(chunk.subarray(start));
      }

      const ending = this.#hold(chunk.subarray(start, newline)) ?? this.#accept(this.#takeLine());

      if (ending !== undefined) {
        return ending;
      }

      start = newline + 1;
    }
  }

  /** No line may pass the terminal bound, because its kind is not known until it is whole. */
  #hold(bytes: Uint8Array): StreamEnding | undefined {
    this.#pendingBytes += bytes.byteLength;

    if (this.#pendingBytes > TURN_TERMINAL_FRAME_MAX_BYTES) return OVERSIZED;

    this.#pending.push(bytes);

    return undefined;
  }

  #takeLine(): Uint8Array {
    const line = new Uint8Array(this.#pendingBytes);
    let offset = 0;

    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.byteLength;
    }

    this.#pending = [];
    this.#pendingBytes = 0;

    return line;
  }

  #accept(line: Uint8Array): StreamEnding | undefined {
    const text = this.#decoder.decode(line);

    if (text.trim() === "") {
      return undefined;
    }

    const parsed = parseFacetFrameLine(text);

    if (parsed.kind === "invalid") {
      return { kind: "invalid", problem: parsed.problem };
    }

    if (parsed.kind === "terminal") {
      return { kind: "terminal", frame: parsed.frame };
    }

    if (parsed.kind === "unknown-kind") {
      this.#drop("unknown-kind");

      return undefined;
    }

    // Progress is never saved, so an oversized frame is left out rather than costing the
    // conversation.
    if (line.byteLength > TURN_PROGRESS_FRAME_MAX_BYTES) {
      this.#drop("oversized-frame");

      return undefined;
    }

    this.#publish(parsed.frame);

    return undefined;
  }
}

class TurnOutput {
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #cancelled = false;

  attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
  }

  cancel(): void {
    this.#cancelled = true;
  }

  readonly publish: Publish = (frame) => {
    if (!this.#cancelled) this.#controller?.enqueue(encodeFrame(frame));
  };

  readonly keepAlive = (): void => {
    if (!this.#cancelled) this.#controller?.enqueue(KEEPALIVE_LINE);
  };

  finish(frame: ProjectTurnFrame): void {
    if (this.#cancelled) return;

    this.#controller?.enqueue(encodeFrame(frame));
    this.#controller?.close();
  }
}

function endingOf(read: Exit.Exit<StreamEnding>): Effect.Effect<StreamEnding> {
  if (Exit.isSuccess(read) || !Cause.hasInterruptsOnly(read.cause)) return read;

  return Effect.succeed(CANCELLED);
}

/**
 * A disconnect interrupts the read and becomes `cancelled`; the settlement after it runs whole, so
 * a disconnect during a save cannot leave the lease neither saved nor released.
 */
function settledTurn(input: ReadTurnStreamInput, output: TurnOutput): Effect.Effect<void> {
  const log = new TurnStreamLog(input.trace, input.now);

  // The deadline races the read alone. The reader is cancelled after whichever ending won.
  const reading = Effect.suspend(() => {
    const reader = new TurnReader(input.frames, log.counting(output.publish), (reason) => {
      log.dropped(reason);
    });

    return input.bound
      .within(keptAlive(reader.read(), output.keepAlive), TIMED_OUT)
      .pipe(Effect.ensuring(reader.stop()));
  });

  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const ending = yield* endingOf(yield* Effect.exit(restore(reading)));

      yield* Effect.sync(() => {
        output.finish(log.settled(endTurn(input, ending)));
      });
    }),
  ).pipe(
    // A failed stream must not make the next turn wait for this one's deadline, so release the
    // lease before the error propagates.
    Effect.onError((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => {
            releaseLease(input, "turn-stream");
            logLeaseAbandoned(input.trace, "stream-failed", "error");
          }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        input.bound.stop();
        input.workspace.end();
      }),
    ),
  );
}

/**
 * The body runs its own program, started by the stream and not by the RPC that returned it, so the
 * turn lives as long as the body. Cancelling the stream is how a disconnected browser stops the
 * work. The deadline covers a lost facet or host that leaves a stream that never ends.
 */
export function readTurnStream(input: ReadTurnStreamInput): ReadableStream<Uint8Array> {
  const output = new TurnOutput();
  const disconnected = new AbortController();
  let settled: Promise<void> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      output.attach(controller);
      settled = runResponseBody(settledTurn(input, output), disconnected.signal);

      return settled;
    },
    cancel() {
      output.cancel();
      // The browser going away ends the whole turn, so the one signal every step holds is aborted
      // too.
      input.bound.stop();
      disconnected.abort();

      return settled?.then(
        () => {},
        () => {},
      );
    },
  });
}
