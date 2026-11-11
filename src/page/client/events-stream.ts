import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { answerOf, fetchEffect, problemText, projectPath, transportDetail } from "./api.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import {
  MaybeTranscriptKey,
  TranscriptResource,
  type TranscriptService,
} from "./transcript-store.js";
import { viewReader } from "./view-reader.js";

const RECONNECT_PAUSE = "1 second";

const STALL_TIMEOUT = "10 seconds";

const REFUSED_PAUSE = "15 seconds";

function resumePath(projectId: string, from: number | undefined): string {
  return `${projectPath(projectId, "/events")}${from === undefined ? "" : `?from=${from}`}`;
}

function connection({
  streamId,
  projectId,
}: {
  readonly streamId: number;
  readonly projectId: string;
}): Stream.Stream<Message, never, TranscriptService> {
  const opened = Effect.gen(function* () {
    const held = yield* TranscriptResource.get.pipe(Effect.mapError(transportDetail));

    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (owned) =>
        Effect.sync(() => {
          owned.abort();
        }),
    );

    const response = yield* fetchEffect(
      resumePath(projectId, held.transcript.resume?.from),
      { method: "GET", accept: "application/x-ndjson", maybeBody: Option.none() },
      controller.signal,
    );

    if (!response.ok || response.body === null) {
      const wording = problemText(yield* answerOf(response));

      return Stream.make<Message[]>(Message.RefusedEvents({ streamId, wording })).pipe(
        Stream.concat(Stream.fromEffectDrain(Effect.sleep(REFUSED_PAUSE))),
      );
    }

    const { body } = response;
    const read = viewReader(held);

    return Stream.fromReadableStream({ evaluate: () => body, onError: transportDetail }).pipe(
      Stream.timeout(STALL_TIMEOUT),
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== ""),
      Stream.map((line): Message =>
        Option.match(read(line), {
          onNone: () => Message.ReceivedUnreadableEvent({ streamId }),
          onSome: (conversation) => Message.ReceivedConversation({ streamId, conversation }),
        }),
      ),
      Stream.concat(
        Stream.make(Message.DisconnectedEvents({ streamId, detail: "the stream ended" })),
      ),
    );
  });

  return Stream.unwrap(opened).pipe(
    Stream.catch((detail) => Stream.make(Message.DisconnectedEvents({ streamId, detail }))),
  );
}

export const subscriptions = Subscription.make<Model, Message, TranscriptService>()((entry) => ({
  events: entry(
    { maybeStream: MaybeTranscriptKey },
    {
      modelToDependencies: (model) => ({
        maybeStream: Option.map(model.maybeProjectId, (projectId) => ({
          streamId: model.eventsStreamId,
          projectId,
        })),
      }),
      dependenciesToStream: ({ maybeStream }) =>
        Option.match(maybeStream, {
          onNone: () => Stream.empty,
          onSome: (stream) =>
            connection(stream).pipe(Stream.repeat(Schedule.spaced(RECONNECT_PAUSE))),
        }),
    },
  ),
}));
