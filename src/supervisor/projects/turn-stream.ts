import {
  parseFacetFrameLine,
  PROJECT_TURN_FRAME_MAX_BYTES,
  type ProjectTurnFrame,
} from "./turn-frames.js";
import { endTurn, type StreamEnding, type TurnSettlement } from "./turn-settle.js";
import type { TurnBound } from "./turn-bound.js";

export type ProjectTurnStreamInput = TurnSettlement &
  Readonly<{
    frames: ReadableStream<Uint8Array>;
    /**
     * When this turn ends, and the cancellation that ends it. The bound was opened at admission
     * and the start already spent part of it, so what is left here is what is left of the turn.
     */
    bound: TurnBound;
  }>;

const encoder = new TextEncoder();

function encodeFrame(frame: ProjectTurnFrame): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

type Publish = (frame: ProjectTurnFrame) => void;

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
  #buffer = "";

  constructor(frames: ReadableStream<Uint8Array>, publish: Publish) {
    this.#reader = frames.getReader();
    this.#publish = publish;
  }

  /** Stop the generation's work. Cancelling its stream is what ends the Pi turn behind it. */
  stop(): Promise<void> {
    return this.#reader.cancel().then(
      () => {},
      () => {},
    );
  }

  /**
   * Read until the turn ends, which is the terminal frame and not the end of the stream.
   *
   * A turn that has said how it ended has nothing left to say, so the read stops at that frame
   * and never looks at what follows it. That is what makes a second terminal frame harmless: it
   * is not read, so it cannot save a second conversation, and the spent lease would refuse it
   * even if it were. Cancelling the reader on the way out is what ends the work behind it, and it
   * is why a generation that goes quiet after its terminal frame cannot hold the project until
   * the deadline.
   */
  async read(cancelled: () => boolean, expired: () => boolean): Promise<StreamEnding> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await this.#reader.read();
        if (chunk.done) {
          break;
        }
        const ending = this.#consume(decoder.decode(chunk.value, { stream: true }));
        if (ending !== undefined) {
          return ending;
        }
      }
    } catch {
      // The generation's stream failed part way through, so the turn has no ending of its own.
      return cancelled() ? { kind: "cancelled" } : { kind: "invalid", problem: "malformed-frame" };
    } finally {
      await this.stop();
    }

    if (cancelled()) return { kind: "cancelled" };
    return expired()
      ? { kind: "timed-out" }
      : { kind: "invalid", problem: "missing-terminal-frame" };
  }

  /** Add decoded text and publish every whole frame it completed, or end the stream. */
  #consume(text: string): StreamEnding | undefined {
    this.#buffer += text;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        return this.#endOfChunk();
      }

      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === "") {
        continue;
      }

      const ending = this.#accept(line);
      if (ending !== undefined) {
        return ending;
      }
    }
  }

  /**
   * Nothing whole is left in the buffer, so the read continues — unless the buffer has passed the
   * frame bound without a newline, which is a line a generation is not allowed to write.
   */
  #endOfChunk(): StreamEnding | undefined {
    return this.#buffer.length > PROJECT_TURN_FRAME_MAX_BYTES
      ? { kind: "invalid", problem: "oversized-frame" }
      : undefined;
  }

  #accept(line: string): StreamEnding | undefined {
    if (line.length > PROJECT_TURN_FRAME_MAX_BYTES) {
      return { kind: "invalid", problem: "oversized-frame" };
    }

    const parsed = parseFacetFrameLine(line);
    if (parsed.kind === "invalid") {
      return { kind: "invalid", problem: parsed.problem };
    }
    if (parsed.kind === "forwarded") {
      this.#publish(parsed.frame);
      return undefined;
    }

    return { kind: "terminal", frame: parsed.frame };
  }
}

/**
 * The turn as the browser reads it: the generation's proven frames, then exactly one terminal
 * frame the Supervisor writes after it has decided what is durable.
 *
 * Cancelling this stream is how a disconnected browser stops the work. It cancels the generation's
 * stream, which ends the Pi turn (`facet/generation-0/facet-turn.ts`), and the lease is then
 * released so the next turn is not made to wait out a deadline nobody is using. The deadline
 * covers the case a disconnect never arrives: a lost facet or an interrupted host leaves a stream
 * that never ends, and the turn must still stop holding the project.
 */
export function projectTurnStream(input: ProjectTurnStreamInput): ReadableStream<Uint8Array> {
  const state = { cancelled: false };
  let turn: TurnReader | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const publish: Publish = (frame) => {
        if (!state.cancelled) controller.enqueue(encodeFrame(frame));
      };
      const reader = new TurnReader(input.frames, publish);
      turn = reader;
      // The turn's own bound, not a second one: when the instant admission fixed arrives, the
      // signal aborts and the generation's stream is cancelled, whether the start left the turn
      // four minutes or four seconds.
      const stopReading = () => {
        void reader.stop();
      };
      input.bound.signal.addEventListener("abort", stopReading, { once: true });
      if (input.bound.signal.aborted) stopReading();

      try {
        const ending = await reader.read(
          () => state.cancelled,
          () => input.bound.timedOut(),
        );
        const end = endTurn(input, ending);
        publish(end.frame);
        input.attempts.settle(input.attempt.id, end.outcome, input.now());
      } finally {
        input.bound.signal.removeEventListener("abort", stopReading);
        input.bound.stop();
        if (!state.cancelled) controller.close();
      }
    },
    cancel() {
      state.cancelled = true;
      // The browser going away ends the whole turn and not only its frames, so the one signal
      // every step of the turn holds is aborted here too.
      input.bound.stop();
      return turn === undefined ? input.frames.cancel() : turn.stop();
    },
  });
}
