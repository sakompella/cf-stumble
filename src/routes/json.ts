import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type ApiErrorCode =
  | "invalid-submission-request"
  | "invalid-activation-request"
  | "invalid-rollback-request"
  | "invalid-connect-request"
  | "invalid-message-request"
  | "invalid-events-request"
  | "invalid-entries-request"
  | "invalid-codex-login-request"
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

export class SupervisorCallFailed extends Data.TaggedError("SupervisorCallFailed")<{
  readonly cause: unknown;
}> {}

export function callSupervisor<A>(call: () => Promise<A>): Effect.Effect<A, SupervisorCallFailed> {
  return Effect.tryPromise({ try: call, catch: (cause) => new SupervisorCallFailed({ cause }) });
}
