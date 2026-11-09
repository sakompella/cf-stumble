import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Result from "effect/Result";

export function runToResult<A, E>(program: Effect.Effect<A, E>): Promise<Result.Result<A, E>> {
  return Effect.runPromise(Effect.result(program));
}

export function runInterruptible<A, E>(program: Effect.Effect<A, E>) {
  const controller = new AbortController();
  const exit = Effect.runPromiseExit(program, { signal: controller.signal });

  return {
    interrupt: () => {
      controller.abort();
    },
    interrupted: exit.then(Exit.hasInterrupts),
  };
}
