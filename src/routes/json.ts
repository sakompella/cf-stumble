import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Endpoint, ProjectEndpoint } from "../api/endpoints.js";
import { ERROR_STATUS, PROBLEM_STATUS, type ErrorCode, type ProblemCode } from "../api/problems.js";
import { logRedactedCause } from "../diagnostics.js";
import { routePattern } from "./route-pattern.js";

export function jsonError(code: ErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status: ERROR_STATUS[code] });
}

export function refusal(
  refused: Readonly<{ ok: false; problem: Readonly<{ code: ProblemCode }> }>,
): Response {
  return Response.json(refused, { status: PROBLEM_STATUS[refused.problem.code] });
}

export class InvalidRequestBody extends Data.TaggedError("InvalidRequestBody") {}

export function decodeRequestBody<S extends Schema.ConstraintDecoder<unknown>>(
  request: Request,
  schema: S,
): Effect.Effect<S["Type"], InvalidRequestBody> {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });

  return Effect.tryPromise(() => request.json()).pipe(
    Effect.flatMap((body) => decode(body)),
    Effect.mapError(() => new InvalidRequestBody()),
  );
}

export function invalidRequestBody(
  code: ErrorCode,
): (
  handled: Effect.Effect<Response, InvalidRequestBody | SupervisorCallFailed>,
) => Effect.Effect<Response, SupervisorCallFailed> {
  return (handled) =>
    Effect.catchTag(handled, "InvalidRequestBody", () => Effect.succeed(jsonError(code)));
}

export class SupervisorCallFailed extends Data.TaggedError("SupervisorCallFailed")<{
  readonly cause: unknown;
}> {}

export function callSupervisor<A>(call: () => Promise<A>): Effect.Effect<A, SupervisorCallFailed> {
  return Effect.tryPromise({ try: call, catch: (cause) => new SupervisorCallFailed({ cause }) });
}

type Routed = Effect.Effect<Response, SupervisorCallFailed>;

export type Handlers<S, K extends Endpoint> = {
  readonly [E in K]: E extends ProjectEndpoint
    ? (request: Request, projectId: string, supervisor: S) => Routed
    : (request: Request, supervisor: S) => Routed;
};

export function answeringInternalErrors(
  request: Request,
): (routed: Routed) => Effect.Effect<Response> {
  return Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.sync(() => {
          const route = routePattern(new URL(request.url).pathname);
          const failure = Cause.squash(cause);
          const thrown = failure instanceof SupervisorCallFailed ? failure.cause : failure;
          logRedactedCause(`api ${request.method} ${route}: internal-error`, thrown);

          return jsonError("internal-error");
        }),
  );
}
