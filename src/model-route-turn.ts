import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AssistantMessage } from "./model-route.js";
import type { ModelRouteErrorCode, ModelStreamEvent, ModelUsage } from "./model-route-events.js";
import { runResponseBody } from "./run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "./stream-keepalive.js";

/**
 * Defense in depth against a runaway stream, not a measured provider limit. Counts raw wire bytes,
 * not string length.
 */
const MAX_STREAM_EVENT_BYTES = 8_388_608;

/**
 * Returns whether `onLine` saw the terminal event. A well-formed provider owes one even in its
 * last chunk, hence one more pass after the final decoder flush.
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

/** Nothing of the provider's own error reaches the caller; `code` is all it learns. */
export class ModelTurnFailed extends Data.TaggedError("ModelTurnFailed")<{
  readonly code: ModelRouteErrorCode;
}> {}

export const modelUnavailable = (): ModelTurnFailed =>
  new ModelTurnFailed({ code: "model-unavailable" });

/**
 * The reader is cancelled however the read ends, so a stream this route stopped reading is
 * released.
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

export type ModelTurn = (
  emit: (event: ModelStreamEvent) => void,
) => Effect.Effect<ModelTurnAnswer, ModelTurnFailed>;

/**
 * The call runs in the stream's own `start`, so its lifetime is the body's, not the RPC call's.
 * While the provider is quiet the stream writes empty lines, so a generation that stops reading
 * across Workers RPC is noticed within seconds.
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
