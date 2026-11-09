import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { MainFacetTarget } from "../../facet/index.js";
import { logRedactedCause } from "../../diagnostics.js";
import { readFirstView, type AssistantMessage } from "../../page/index.js";
import { startupCheckSteps } from "../../startup-check-model.js";
import { describe, finalAnswer, isReply, turnStep } from "./answer.js";

const POLL_MS = 100;

type FinalAnswer = Readonly<{ answer: AssistantMessage; step: string }>;

type StepFailure = Readonly<{ step: string; reason: string }>;

export type ScriptedTurn = Readonly<{
  conversationId: string;
  message: string;
  label: string;
  answers: number;
  name: string;
}>;

export function scriptedTurn(
  facet: Fetcher<MainFacetTarget>,
  turn: ScriptedTurn,
): Effect.Effect<void, string> {
  const failedAt = ({ step, reason }: StepFailure) =>
    `${turn.name} failed at step ${step}: ${reason}`;

  return candidateCall("the candidate did not submit the turn", () =>
    facet.submit(turn.conversationId, turn.message, turn.label),
  ).pipe(
    Effect.andThen(
      settledAnswer(facet, turn.conversationId, turn.answers, startupCheckSteps(turn.message)).pipe(
        Effect.mapError(failedAt),
      ),
    ),
    Effect.flatMap(({ answer, step }) =>
      isReply(answer) ? Effect.void : Effect.fail(failedAt({ step, reason: describe(answer) })),
    ),
  );
}

export function candidateCall<T>(
  failure: string,
  call: () => Promise<T>,
): Effect.Effect<T, string> {
  return Effect.tryPromise({ try: call, catch: candidateFailure(failure) });
}

function candidateFailure(failure: string): (cause: unknown) => string {
  return (cause) => {
    logRedactedCause(`supervisor.startup-check: ${failure}`, cause);

    return failure;
  };
}

function settledAnswer(
  candidate: Fetcher<MainFacetTarget>,
  conversationId: string,
  answers: number,
  steps: readonly string[],
  step = steps[0] ?? "",
): Effect.Effect<FinalAnswer, StepFailure> {
  return snapshotLine(candidate, conversationId).pipe(
    Effect.mapError((reason): StepFailure => ({ step, reason })),
    Effect.flatMap((line) => {
      const conversation = readFirstView(line);

      if (Option.isNone(conversation)) {
        return Effect.fail({
          step,
          reason: "the startup-check conversation did not open with a readable view",
        });
      }

      const seen = turnStep(conversation.value, steps);
      const answer = finalAnswer(conversation.value, answers);

      return answer === undefined
        ? Effect.sleep(POLL_MS).pipe(
            Effect.andThen(settledAnswer(candidate, conversationId, answers, steps, seen)),
          )
        : Effect.succeed({ answer, step: seen });
    }),
  );
}

function snapshotLine(
  candidate: Fetcher<MainFacetTarget>,
  conversationId: string,
): Effect.Effect<string, string> {
  return candidateCall("the candidate did not provide the event stream", () =>
    candidate.events(conversationId),
  ).pipe(
    Effect.flatMap((events) =>
      Stream.fromReadableStream({
        evaluate: () => events,
        onError: candidateFailure("the candidate did not provide the event stream"),
      }).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.map(Option.getOrElse(() => "")),
      ),
    ),
  );
}
