import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

export function runToResult<A, E>(program: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(program));
}

export function plainProblem(problem: Readonly<{ code: string }>) {
  return {
    code: problem.code,
    ...Object.fromEntries(Object.entries(problem).filter(([key]) => key !== "_tag")),
  };
}
