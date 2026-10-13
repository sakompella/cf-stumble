import * as Effect from "effect/Effect";

/**
 * How often a quiet stream writes an empty line.
 *
 * Workers RPC tells a stream's source that its reader went away only when the source next writes.
 * A source waiting on slow work, such as a command or a model's first token, writes nothing, so
 * without these lines it hears that nobody reads it only when the work ends.
 */
const KEEPALIVE_MS = 2_000;

/** The empty line a quiet stream writes, which every reader of these NDJSON streams skips. */
export const KEEPALIVE_LINE = new TextEncoder().encode("\n");

/** Run `work`, and call `keepAlive` every {@link KEEPALIVE_MS} until it ends, however it ends. */
export function keptAlive<A, E>(
  work: Effect.Effect<A, E>,
  keepAlive: () => void,
): Effect.Effect<A, E> {
  const beat = Effect.sleep(KEEPALIVE_MS).pipe(
    Effect.andThen(Effect.sync(keepAlive)),
    Effect.forever,
  );

  return Effect.raceFirst(work, beat);
}
