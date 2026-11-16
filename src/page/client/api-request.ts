import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { methodOf, targetPath, type EndpointTarget } from "../../api/endpoints.js";
import {
  answerOf,
  decodeRefusal,
  fetchEffect,
  refusalText,
  unreadableText,
  type JsonBody,
  type Refusal,
} from "./api.js";

export type ApiRequest<S extends Schema.ConstraintDecoder<unknown>> = Readonly<{
  target: EndpointTarget;
  maybeBody: Option.Option<JsonBody>;
  answer: S;
}>;

export type Outcomes<A, Answered, Refused, Unreadable, Failed> = Readonly<{
  answered: (answer: A, now: number) => Answered;
  refused: (refusal: Refusal, status: number) => Refused;
  unreadable: (status: number) => Unreadable;
  failed: (detail: string) => Failed;
}>;

export function apiRequest<
  S extends Schema.ConstraintDecoder<unknown>,
  Answered,
  Refused,
  Unreadable,
  Failed,
>(
  request: ApiRequest<S>,
  outcomes: Outcomes<S["Type"], Answered, Refused, Unreadable, Failed>,
): Effect.Effect<Answered | Refused | Unreadable | Failed> {
  return fetchEffect(targetPath(request.target), {
    method: methodOf(request.target.endpoint),
    accept: "application/json",
    maybeBody: request.maybeBody,
  }).pipe(
    Effect.flatMap(answerOf),
    Effect.flatMap(({ status, payload }) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        Option.match(Schema.decodeOption(request.answer)(payload), {
          onSome: (answer) => outcomes.answered(answer, now),
          onNone: () =>
            Option.match(decodeRefusal(payload), {
              onSome: (refusal) => outcomes.refused(refusal, status),
              onNone: () => outcomes.unreadable(status),
            }),
        }),
      ),
    ),
    Effect.catch((detail) => Effect.succeed(outcomes.failed(detail))),
  );
}

export function rejectedAs<Rejected>(
  reject: (wording: string) => Rejected,
): Pick<Outcomes<never, never, Rejected, Rejected, never>, "refused" | "unreadable"> {
  return {
    refused: (refusal) => reject(refusalText(refusal)),
    unreadable: (status) => reject(unreadableText(status)),
  };
}
