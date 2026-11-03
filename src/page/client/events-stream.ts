import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { answerOf, fetchEffect, problemText, projectPath, transportDetail } from "./api.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import {
  closeTranscript,
  openTranscript,
  viewReader,
  type HeldTranscript,
} from "./transcript-store.js";

const RECONNECT_PAUSE = "1 second";

const STALL_TIMEOUT = "10 seconds";

const EventsStream = Schema.Struct({ streamId: Schema.Number, projectId: Schema.String });

type EventsStream = typeof EventsStream.Type;

function resumePath(projectId: string, held: HeldTranscript): string {
  const from = held.transcript.resume?.from;

  return `${projectPath(projectId, "/events")}${from === undefined ? "" : `?from=${from}`}`;
}

function connection(
  { streamId, projectId }: EventsStream,
  held: HeldTranscript,
): Stream.Stream<Message> {
  const opened = Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (owned) =>
        Effect.sync(() => {
          owned.abort();
        }),
    );

    const response = yield* fetchEffect(
      resumePath(projectId, held),
      { method: "GET", accept: "application/x-ndjson", maybeBody: Option.none() },
      controller.signal,
    );

    if (!response.ok || response.body === null) {
      const wording = problemText(yield* answerOf(response));

      return Stream.make<Message[]>(Message.RefusedEvents({ streamId, wording }));
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

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  events: entry(
    { maybeStream: Schema.Option(EventsStream) },
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
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => openTranscript(stream.streamId, stream.projectId)),
                () =>
                  Effect.sync(() => {
                    closeTranscript(stream.streamId);
                  }),
              ).pipe(
                Effect.map((held) =>
                  connection(stream, held).pipe(Stream.repeat(Schedule.spaced(RECONNECT_PAUSE))),
                ),
              ),
            ),
        }),
    },
  ),
}));
