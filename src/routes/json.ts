import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Endpoint, ProjectEndpoint } from "../api/endpoints.js";
import { logRedactedCause } from "../diagnostics.js";
import { routePattern } from "./route-pattern.js";

type ApiErrorCode =
  | "invalid-submission-request"
  | "invalid-activation-request"
  | "invalid-rollback-request"
  | "invalid-connect-request"
  | "invalid-message-request"
  | "invalid-events-request"
  | "invalid-entries-request"
  | "invalid-chatgpt-request"
  | "invalid-backend-request"
  | "cross-origin-request"
  | "not-found"
  | "preparation-failed"
  | "internal-error";

export function jsonError(status: number, code: ApiErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status });
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
  code: ApiErrorCode,
): (
  handled: Effect.Effect<Response, InvalidRequestBody | SupervisorCallFailed>,
) => Effect.Effect<Response, SupervisorCallFailed> {
  return (handled) =>
    Effect.catchTag(handled, "InvalidRequestBody", () => Effect.succeed(jsonError(400, code)));
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

          return jsonError(500, "internal-error");
        }),
  );
}
