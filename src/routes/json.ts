import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Codes name the fault in the request or route, never the cause inside the Supervisor, so no internal
 * error text or credential reaches the client.
 */
type ApiErrorCode =
  | "invalid-submission-request"
  | "invalid-activation-request"
  | "invalid-rollback-request"
  | "invalid-connect-request"
  | "invalid-message-request"
  | "invalid-chatgpt-request"
  | "cross-origin-request"
  | "not-found"
  | "internal-error";

export function jsonError(status: number, code: ApiErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class InvalidRequestBody extends Data.TaggedError("InvalidRequestBody") {}

/** A body must carry exactly the fields the schema names; an extra field is a refusal. */
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

/**
 * A Supervisor RPC rejected. Its cause can come from a generation's code or a workspace command,
 * so the route that catches this logs the cause redacted and never answers with it.
 */
export class SupervisorCallFailed extends Data.TaggedError("SupervisorCallFailed")<{
  readonly cause: unknown;
}> {}

export function callSupervisor<A>(call: () => Promise<A>): Effect.Effect<A, SupervisorCallFailed> {
  return Effect.tryPromise({ try: call, catch: (cause) => new SupervisorCallFailed({ cause }) });
}
