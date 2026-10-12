import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Subscription } from "foldkit";
import { answerOf, fetchEffect, projectPath, transportDetail, turnRefusalText } from "./api.js";
import { TurnFrame } from "./frames.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";

/**
 * The streaming turn: `POST /api/projects/{id}/turn` and the newline-delimited frames it answers
 * with (ADR-0037).
 *
 * The turn is a Subscription because its lifetime belongs to the Model: the stream runs exactly
 * while `model.turn` is `Streaming`. Cancelling, or selecting another project, sets the turn back
 * to `Idle`; Foldkit then closes the stream's scope, which aborts the fetch and cancels the
 * response body. That cancellation is how the Supervisor learns the browser is gone.
 */

const TurnRequest = Schema.Struct({
  turnId: Schema.Number,
  projectId: Schema.String,
  prompt: Schema.String,
});

type TurnRequest = typeof TurnRequest.Type;

function lineMessages(turnId: number, line: string): readonly Message[] {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- JSON.parse is where the frame enters; the Schema below proves it.
  const maybeParsed = Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(line);

  if (Option.isNone(maybeParsed) || maybeParsed.value === null) {
    return [Message.ReceivedUnreadableFrame({ turnId })];
  }

  // A frame of a kind this page does not know is skipped, as it always was.
  return Option.toArray(
    Option.map(Schema.decodeUnknownOption(TurnFrame)(maybeParsed.value), (frame) =>
      Message.ReceivedTurnFrame({ turnId, frame }),
    ),
  );
}

function frameMessages(turnId: number, body: ReadableStream<Uint8Array>): Stream.Stream<Message> {
  return Stream.fromReadableStream({ evaluate: () => body, onError: transportDetail }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.map((line) => lineMessages(turnId, line)),
    Stream.flattenIterable,
    Stream.concat(Stream.make(Message.EndedTurnStream({ turnId }))),
    Stream.catch((detail) => Stream.make(Message.DisconnectedTurnStream({ turnId, detail }))),
  );
}

/**
 * The request and its body share the stream's scope: when Foldkit closes it, the controller aborts
 * the fetch, and the body's reader is cancelled. Either one tells the Worker the browser left.
 */
function turnStream(request: TurnRequest): Stream.Stream<Message> {
  const { turnId } = request;

  const opened = Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (owned) =>
        Effect.sync(() => {
          owned.abort();
        }),
    );

    const response = yield* fetchEffect(
      projectPath(request.projectId, "/turn"),
      {
        method: "POST",
        accept: "application/x-ndjson",
        maybeBody: Option.some({ prompt: request.prompt }),
      },
      controller.signal,
    );

    if (!response.ok || response.body === null) {
      const wording = turnRefusalText(yield* answerOf(response));

      return Stream.make(Message.RefusedTurn({ turnId, wording }));
    }

    return frameMessages(turnId, response.body);
  });

  return Stream.unwrap(
    opened.pipe(
      Effect.catch((detail) =>
        Effect.succeed(Stream.make(Message.DisconnectedTurnStream({ turnId, detail }))),
      ),
    ),
  );
}

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  turn: entry(
    { maybeRequest: Schema.Option(TurnRequest) },
    {
      modelToDependencies: (model) => ({
        maybeRequest:
          model.turn._tag === "Streaming"
            ? Option.some({
                turnId: model.turn.turnId,
                projectId: model.turn.projectId,
                prompt: model.turn.prompt,
              })
            : Option.none(),
      }),
      dependenciesToStream: ({ maybeRequest }) =>
        Option.match(maybeRequest, { onNone: () => Stream.empty, onSome: turnStream }),
    },
  ),
}));
