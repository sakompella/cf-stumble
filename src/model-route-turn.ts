import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AssistantMessage } from "./model-route.js";
import type { ModelRouteErrorCode, ModelStreamEvent, ModelUsage } from "./model-route-events.js";
import { runResponseBody } from "./run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "./stream-keepalive.js";

const MAX_STREAM_EVENT_BYTES = 8_388_608;

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

export class ModelTurnFailed extends Data.TaggedError("ModelTurnFailed")<{
  readonly code: ModelRouteErrorCode;
}> {}

export const modelUnavailable = (): ModelTurnFailed =>
  new ModelTurnFailed({ code: "model-unavailable" });

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
    (reader) => Effect.promise(() => reader.cancel().catch(() => {})),
  ).pipe(
    Effect.flatMap((terminated) => (terminated ? Effect.void : Effect.fail(modelUnavailable()))),
  );
}

export type ModelTurnAnswer = Readonly<{ message: AssistantMessage; usage: ModelUsage }>;

export type ModelTurn = (
  emit: (event: ModelStreamEvent) => void,
) => Effect.Effect<ModelTurnAnswer, ModelTurnFailed>;

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
