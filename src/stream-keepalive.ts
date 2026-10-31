import * as Effect from "effect/Effect";

const KEEPALIVE_MS = 2_000;

export const KEEPALIVE_LINE = new TextEncoder().encode("\n");

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
