import * as Effect from "effect/Effect";

/**
 * Run one host program at a native entry point, such as the Worker's `fetch`, and hand the
 * platform the ordinary Promise it expects.
 *
 * The error channel is `never` on purpose. Every expected failure must already be turned into the
 * plain value the entry point returns, so no Effect error, `Exit`, or `Cause` reaches the platform
 * or a caller. A defect still rejects the Promise with the value that was thrown, which
 * is what an `async` entry point that threw would do.
 */
export function runAtEntryPoint<A>(program: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(program);
}
