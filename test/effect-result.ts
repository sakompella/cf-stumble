import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

export function resultOf<A, E>(program: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(program));
}
