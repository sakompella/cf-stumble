import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Sse } from "effect/encoding";
import * as Predicate from "effect/Predicate";
import { redactedExcerpt } from "./diagnostics.js";
import type { AssistantMessage } from "./model-route-wire/request.js";
import type {
  ModelRouteErrorCode,
  ModelStreamEvent,
  ModelUsage,
} from "./model-route-wire/events.js";
import { MAX_STREAM_EVENT_BYTES } from "./model-route-wire/stream-limits.js";
import { runResponseBody } from "./run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "./stream-keepalive.js";

async function readSseEvents<Chunk extends Uint8Array>(
  reader: ReadableStreamDefaultReader<Chunk>,
  onEvent: (data: string) => boolean,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let terminal = false;

  const parser = Sse.makeParser(
    (event) => {
      if (Predicate.isTagged(event, "Event") && onEvent(event.data)) terminal = true;
    },
    { maxEventSize: MAX_STREAM_EVENT_BYTES },
  );

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    totalBytes += next.value.byteLength;

    if (totalBytes > MAX_STREAM_EVENT_BYTES) {
      throw new Error("provider stream exceeded the event byte bound");
    }

    if (parser.feed(decoder.decode(next.value, { stream: true })) !== undefined) {
      throw new Error("provider stream exceeded the event byte bound");
    }

    if (terminal) return true;
  }

  parser.feed(decoder.decode());

  return terminal;
}

export class ModelTurnFailed extends Data.TaggedError("ModelTurnFailed")<{
  readonly code: ModelRouteErrorCode;
  readonly detail?: string;
}> {}

export const modelUnavailable = (cause?: unknown): ModelTurnFailed =>
  cause instanceof Error
    ? modelUnavailableBecause(cause.message)
    : new ModelTurnFailed({ code: "model-unavailable" });

export const modelUnavailableBecause = (detail: string): ModelTurnFailed =>
  new ModelTurnFailed({ code: "model-unavailable", detail: redactedExcerpt(detail) });

export function pumpSseStream<Chunk extends Uint8Array>(
  providerStream: ReadableStream<Chunk>,
  onEvent: (data: string) => boolean,
): Effect.Effect<void, ModelTurnFailed> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => providerStream.getReader(),
      catch: modelUnavailable,
    }),
    (reader) =>
      Effect.tryPromise({
        try: () => readSseEvents(reader, onEvent),
        catch: modelUnavailable,
      }),
    (reader) => Effect.promise(() => reader.cancel().catch(() => {})),
  ).pipe(
    Effect.flatMap((terminated) =>
      terminated
        ? Effect.void
        : Effect.fail(modelUnavailableBecause("the stream ended without a terminal event")),
    ),
  );
}

export type ModelTurnAnswer = Readonly<{
  message: AssistantMessage;
  usage: ModelUsage;
  truncated?: true;
}>;

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
          onFailure: ({ code, detail }) => {
            emit({ type: "error", error: detail === undefined ? { code } : { code, detail } });
          },
          onSuccess: (answer) => {
            emit({ type: "done", ...answer });
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
