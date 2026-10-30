import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * The error channel is `never`: every expected failure must already be a plain value, so no Effect
 * error, `Exit` or `Cause` reaches the platform. A defect rejects with the thrown value.
 */
export function runAtEntryPoint<A>(program: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(program);
}

/**
 * A body outlives the program that returned its headers, so it gets its own interpreter; aborting
 * `cancelled` interrupts it. A defect rejects with the thrown value, which errors the stream.
 */
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
