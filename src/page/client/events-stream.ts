import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { answerOf, fetchEffect, problemText, projectPath, transportDetail } from "./api.js";
import { EventLine, eventLine } from "./events.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";

/**
 * One events stream stays open for the selected project. When it ends or drops, the page opens it
 * again after a pause; every connection starts with a snapshot, so nothing missed in between is
 * lost. Selecting another project or starting a fresh thread changes the stream's id, and Foldkit
 * closes the old stream's scope, which aborts its fetch.
 */

const RECONNECT_PAUSE = "1 second";

const EventsStream = Schema.Struct({ streamId: Schema.Number, projectId: Schema.String });

type EventsStream = typeof EventsStream.Type;

function lineMessages(streamId: number, line: string): readonly Message[] {
  return EventLine.match<readonly Message[]>(eventLine(line), {
    Event: ({ event }) => [Message.ReceivedEvent({ streamId, event })],
    Unread: () => [],
    Unreadable: () => [Message.ReceivedUnreadableEvent({ streamId })],
  });
}

function connection({ streamId, projectId }: EventsStream): Stream.Stream<Message> {
  const opened = Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (owned) =>
        Effect.sync(() => {
          owned.abort();
        }),
    );

    const response = yield* fetchEffect(
      projectPath(projectId, "/events"),
      { method: "GET", accept: "application/x-ndjson", maybeBody: Option.none() },
      controller.signal,
    );

    if (!response.ok || response.body === null) {
      const wording = problemText(yield* answerOf(response));

      return Stream.make(Message.RefusedEvents({ streamId, wording }));
    }

    const { body } = response;

    return Stream.fromReadableStream({ evaluate: () => body, onError: transportDetail }).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== ""),
      Stream.map((line) => lineMessages(streamId, line)),
      Stream.flattenIterable,
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
            connection(stream).pipe(Stream.repeat(Schedule.spaced(RECONNECT_PAUSE))),
        }),
    },
  ),
}));
