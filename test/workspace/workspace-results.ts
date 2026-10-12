import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

/** Run a workspace program to its success or its typed failure, which the assertions compare. */
export function runToResult<A, E>(program: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(program));
}

/** A tagged failure as its stable code and data fields, without the tag. */
export function plainProblem(problem: Readonly<{ code: string }>) {
  return {
    code: problem.code,
    ...Object.fromEntries(Object.entries(problem).filter(([key]) => key !== "_tag")),
  };
}
