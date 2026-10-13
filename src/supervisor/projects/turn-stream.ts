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
import { logLeaseAbandoned, TurnStreamLog, type TurnTrace } from "./turn-log.js";

type ReadTurnStreamInput = TurnSettlement &
  Readonly<{
    frames: ReadableStream<Uint8Array>;
    /**
     * When this turn ends, and the cancellation that ends it. The bound was opened at admission
     * and the start already spent part of it, so what is left here is what is left of the turn.
     */
    bound: TurnBound;
    /** The turn's capability, ended once the turn has settled, however it ended. */
    workspace: TurnWorkspace;
    /** Who this turn is in the operational log. */
    trace: TurnTrace;
  }>;

const encoder = new TextEncoder();

function encodeFrame(frame: ProjectTurnFrame): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

type Publish = (frame: ProjectTurnFrame) => void;

const CANCELLED: StreamEnding = { kind: "cancelled" };

const TIMED_OUT: StreamEnding = { kind: "timed-out" };

const MALFORMED: StreamEnding = { kind: "invalid", problem: "malformed-frame" };

const MISSING_TERMINAL: StreamEnding = { kind: "invalid", problem: "missing-terminal-frame" };

const OVERSIZED: StreamEnding = { kind: "invalid", problem: "oversized-frame" };

const NEWLINE = 0x0a;

/**
 * The server's reader of one generation's turn stream.
 *
 * The Supervisor does the reading, not the browser: every frame is proved here before any byte
 * reaches a client, and the turn's ending is decided from what this loop saw rather than from what
 * a client managed to receive. It holds the reader itself, because both a disconnect and the turn
 * deadline end a turn by cancelling it.
 */
class TurnReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #publish: Publish;
  readonly #decoder = new TextDecoder();
  /**
   * The bytes of the line not yet ended. Lines are split on the newline byte, which never occurs
   * inside a multi-byte UTF-8 character, so each line is measured in bytes before it is decoded.
   */
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;

  constructor(frames: ReadableStream<Uint8Array>, publish: Publish) {
    this.#reader = frames.getReader();
    this.#publish = publish;
  }

  /**
   * Read until the turn ends, which is the terminal frame and not the end of the stream.
   *
   * A turn that has said how it ended has nothing left to say, so the read stops at that frame
   * and never looks at what follows it. That is what makes a second terminal frame harmless: it
   * is not read, so it cannot save a second conversation, and the spent lease would refuse it
   * even if it were. The caller cancels the reader once the read has ended or was interrupted
   * ({@link stop}), which is why a generation that goes quiet after its terminal frame cannot hold
   * the project until the deadline.
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

  /**
   * Stop the generation's work. Cancelling its stream is what ends the Pi turn behind it. It runs
   * after the ending is decided, so a slow acknowledgement cannot turn a terminal frame that
   * already arrived into a timeout.
   */
  stop(): Effect.Effect<void> {
    return Effect.promise(() =>
      this.#reader.cancel().then(
        () => {},
        () => {},
      ),
    );
  }

  /** Publish every whole frame this chunk completed, or end the stream. */
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

  /**
   * Keep part of the line being read. No line may pass the terminal bound, because its kind is not
   * known until it is whole; {@link #accept} applies the smaller progress bound once it is.
   */
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

    if (line.byteLength > TURN_PROGRESS_FRAME_MAX_BYTES) {
      return OVERSIZED;
    }

    this.#publish(parsed.frame);

    return undefined;
  }
}

/** The browser's side of the stream. Once the browser cancels, nothing more is written to it. */
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

  /** Write an empty line, which every reader of a turn skips. */
  readonly keepAlive = (): void => {
    if (!this.#cancelled) this.#controller?.enqueue(KEEPALIVE_LINE);
  };

  /** Write the one terminal frame and close, which happens exactly once per turn. */
  finish(frame: ProjectTurnFrame): void {
    if (this.#cancelled) return;

    this.#controller?.enqueue(encodeFrame(frame));
    this.#controller?.close();
  }
}

/** A read that was interrupted is a disconnect. Any other failure is the stream's, and stays one. */
function endingOf(read: Exit.Exit<StreamEnding>): Effect.Effect<StreamEnding> {
  if (Exit.isSuccess(read) || !Cause.hasInterruptsOnly(read.cause)) return read;

  return Effect.succeed(CANCELLED);
}

/**
 * Read the generation's stream to its ending and settle the turn from it.
 *
 * The read is the only interruptible part. A disconnect interrupts it, and that becomes the
 * `cancelled` ending; the settlement after it runs whole, so a disconnect that arrives during a
 * save cannot leave the lease neither saved nor released. The deadline races the read on the
 * instant admission fixed, not a second budget.
 */
function settledTurn(input: ReadTurnStreamInput, output: TurnOutput): Effect.Effect<void> {
  const log = new TurnStreamLog(input.trace, input.now);

  // The deadline races the read alone. Cancelling the reader, which also ends the work behind it,
  // follows whichever ending won, whether the read ended, timed out, or was interrupted.
  const reading = Effect.suspend(() => {
    const reader = new TurnReader(input.frames, log.counting(output.publish));

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
    // A stream can fail before its reader exists, or while settling a terminal frame. Neither path
    // finished `endTurn`, so release the admitted lease before the stream error reaches its
    // caller. A failed stream must not make the next turn wait for this one's deadline.
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
 * The turn as the browser reads it: the generation's proven frames, then exactly one terminal
 * frame the Supervisor writes after it has decided what is durable.
 *
 * The body runs its own program (`runResponseBody`), started by the stream and not by the RPC
 * that returned it, so the turn lives as long as the body and not as long as the answer that
 * carried it (ADR-0037). Cancelling this stream is how a disconnected browser stops the work: it
 * interrupts the read, which cancels the generation's stream and so ends the Pi turn
 * (`facet/generation-0/facet-turn.ts`), and the lease is then released so the next turn is not
 * made to wait out a deadline nobody is using. The deadline covers the case a disconnect never
 * arrives: a lost facet or an interrupted host leaves a stream that never ends, and the turn must
 * still stop holding the project.
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
      // The browser going away ends the whole turn and not only its frames, so the one signal
      // every step of the turn holds is aborted here too.
      input.bound.stop();
      disconnected.abort();

      return settled?.then(
        () => {},
        () => {},
      );
    },
  });
}
