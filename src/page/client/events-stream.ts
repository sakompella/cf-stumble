import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { answerOf, fetchEffect, problemText, endpointPath, transportDetail } from "./api.js";
import { Message } from "./message.js";
import { TranscriptResource, type TranscriptService } from "./transcript-store.js";
import { viewReader } from "../../conversation-view/view-reader.js";

const RECONNECT_PAUSE = "1 second";

const STALL_TIMEOUT = "10 seconds";

const REFUSED_PAUSE = "15 seconds";

function resumePath(projectId: string, from: number | undefined): string {
  return `${endpointPath("GET /api/projects/:projectId/events", projectId)}${from === undefined ? "" : `?from=${from}`}`;
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

export function eventsOf(stream: {
  readonly streamId: number;
  readonly projectId: string;
}): Stream.Stream<Message, never, TranscriptService> {
  return connection(stream).pipe(Stream.repeat(Schedule.spaced(RECONNECT_PAUSE)));
}
