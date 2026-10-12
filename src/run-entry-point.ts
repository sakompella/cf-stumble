import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Run one host program at a native entry point, such as the Worker's `fetch`, and hand the
 * platform the ordinary Promise it expects.
 *
 * The error channel is `never` on purpose. Every expected failure must already be turned into the
 * plain value the entry point returns, so no Effect error, `Exit`, or `Cause` reaches the platform
 * or a caller (ADR-0045). A defect still rejects the Promise with the value that was thrown, which
 * is what an `async` entry point that threw would do.
 */
export function runAtEntryPoint<A>(program: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(program);
}

/**
 * Run the program that produces a streamed response body, from the body's own `start`.
 *
 * A body outlives the program that returned its headers, so it gets its own interpreter: the
 * program runs until it settles, and aborting `cancelled` (the body's `cancel`) interrupts it.
 * The Promise resolves when the program ends, cancelled or not, so a `ReadableStream` can return
 * it from `start` and from `cancel`. A defect rejects it with the value that was thrown, which
 * errors the stream as a throwing `start` would.
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
