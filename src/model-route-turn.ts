/**
 * One model call as the model route runs it, whichever provider answers: read the provider's
 * Server-Sent Events line by line, and turn the call's outcome into the plain NDJSON
 * `ModelStreamEvent`s that `ModelRoute.runStream` returns. `./model-route-stream.ts` (Workers AI)
 * and `./chatgpt/model-turn.ts` (ChatGPT) each build a {@link ModelTurn} from these parts.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AssistantMessage } from "./model-route.js";
import type { ModelRouteErrorCode, ModelStreamEvent, ModelUsage } from "./model-route-events.js";
import { runResponseBody } from "./run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "./stream-keepalive.js";

/**
 * Upper bound on the bytes this route will read from one provider stream. Applies to the
 * provider's raw wire bytes, not `JSON.stringify(...).length`, for the same reason
 * `validateRequest`'s request bound does: a byte cap stated in string length would not be a byte
 * cap. This is defense in depth against a runaway or misbehaving stream, not a measured provider
 * limit — generation 0 has none to report.
 */
const MAX_STREAM_EVENT_BYTES = 8_388_608;

/**
 * Decode one provider byte stream into lines and feed each to `onLine`, honoring split UTF-8
 * across chunk boundaries. Returns whether `onLine` saw the provider's terminal event; a
 * well-formed provider owes one even in its very last chunk, which is why the final decoder flush
 * gets one more pass over `onLine` too.
 */
async function readSseLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => boolean,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    totalBytes += next.value.byteLength;

    if (totalBytes > MAX_STREAM_EVENT_BYTES) {
      throw new Error("provider stream exceeded the event byte bound");
    }

    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (onLine(line)) return true;
    }
  }

  buffer += decoder.decode();

  for (const line of buffer.split("\n")) {
    if (onLine(line)) return true;
  }

  return false;
}

/**
 * The provider did not give this turn a complete answer, and `code` is the one thing the caller
 * learns about why. For `model-unavailable` that covers a failed call, a stream that failed or
 * ended before its terminal event, and a stream past the byte bound; nothing of the provider's own
 * error reaches the caller.
 */
export class ModelTurnFailed extends Data.TaggedError("ModelTurnFailed")<{
  readonly code: ModelRouteErrorCode;
}> {}

export const modelUnavailable = (): ModelTurnFailed =>
  new ModelTurnFailed({ code: "model-unavailable" });

/**
 * Read one provider SSE byte stream line by line until `onLine` reports the terminal event. The
 * reader is cancelled however the read ends, so a stream this route stopped reading is released.
 * A stream that ends or fails before its terminal event fails the turn.
 */
export function pumpSseStream(
  providerStream: ReadableStream<Uint8Array>,
  onLine: (line: string) => boolean,
): Effect.Effect<void, ModelTurnFailed> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => providerStream.getReader(),
      catch: modelUnavailable,
    }),
    (reader) =>
      Effect.tryPromise({
        try: () => readSseLines(reader, onLine),
        catch: modelUnavailable,
      }),
    (reader) =>
      Effect.promise(() =>
        reader.cancel().catch(() => {
          /* the stream already ended or failed; nothing more to release */
        }),
      ),
  ).pipe(
    Effect.flatMap((terminated) => (terminated ? Effect.void : Effect.fail(modelUnavailable()))),
  );
}

export type ModelTurnAnswer = Readonly<{ message: AssistantMessage; usage: ModelUsage }>;

/** One provider call that emits its deltas as they arrive and ends with the assembled answer. */
export type ModelTurn = (
  emit: (event: ModelStreamEvent) => void,
) => Effect.Effect<ModelTurnAnswer, ModelTurnFailed>;

/**
 * Run one provider call and translate it into plain {@link ModelStreamEvent}s. Every outcome — a
 * provider rejection, a truncated stream, or a clean finish — becomes an event on the returned
 * stream; nothing here throws across the RPC boundary or resolves a rejected promise.
 *
 * The call runs in the stream's own `start`, so its lifetime is the body's, not the RPC call's
 * that returned the stream. Cancelling the stream interrupts the call, which aborts the provider
 * request or cancels its stream. While the provider is quiet the stream writes empty lines, so a
 * generation that stops reading across Workers RPC is heard of within seconds.
 */
export function modelEventStream(turn: ModelTurn): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  let ended: Promise<void> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      function write(bytes: Uint8Array): void {
        if (!cancelled.signal.aborted) controller.enqueue(bytes);
      }

      function emit(event: ModelStreamEvent): void {
        write(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      const answered = turn(emit).pipe(
        Effect.match({
          onFailure: ({ code }) => {
            emit({ type: "error", error: { code } });
          },
          onSuccess: ({ message, usage }) => {
            emit({ type: "done", message, usage });
          },
        }),
      );

      const program = keptAlive(answered, () => {
        write(KEEPALIVE_LINE);
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            controller.close();
          }),
        ),
      );

      ended = runResponseBody(program, cancelled.signal);

      return ended;
    },
    cancel() {
      cancelled.abort();

      return ended?.then(
        () => {},
        () => {},
      );
    },
  });
}
