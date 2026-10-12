import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Every owner API failure that is not a Supervisor decision uses one of these codes. The codes name
 * the fault in the request or the route, never the cause inside the Supervisor, so no internal
 * error text or credential can reach the client.
 */
type ApiErrorCode =
  | "invalid-submission-request"
  | "invalid-activation-request"
  | "invalid-rollback-request"
  | "invalid-connect-request"
  | "invalid-turn-request"
  | "cross-origin-request"
  | "not-found"
  | "internal-error";

export function jsonError(status: number, code: ApiErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

/** A count in a request body: a safe integer, zero or more. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The body was not JSON, or not the exact shape the route accepts. Each route answers its own 400. */
export class InvalidRequestBody extends Data.TaggedError("InvalidRequestBody") {}

/**
 * Read a request body as JSON and decode it with `schema`. A body must carry exactly the fields the
 * schema names, so an extra field is a refusal rather than something dropped quietly.
 */
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
