import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export function runAtEntryPoint<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

export function runResponseBody(
  program: Effect.Effect<void>,
  cancelled: AbortSignal,
): Promise<void> {
  return Effect.runPromiseExit(program, { signal: cancelled }).then((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      throw Cause.squash(exit.cause);
    }
  });
}
