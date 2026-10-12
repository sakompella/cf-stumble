import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

/** Run a host program to its Result, so a test can assert on its success or its typed failure. */
export function resultOf<A, E>(program: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(program));
}
