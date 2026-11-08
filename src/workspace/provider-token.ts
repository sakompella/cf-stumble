import * as Effect from "effect/Effect";

function sha256(text: string): Effect.Effect<ArrayBuffer> {
  return Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function providerTokenMatches(
  expected: string | undefined,
  presented: string | null,
): Effect.Effect<boolean> {
  if (expected === undefined || expected === "" || presented === null) return Effect.succeed(false);

  return Effect.all([sha256(expected), sha256(presented)], { concurrency: "unbounded" }).pipe(
    Effect.map(([expectedDigest, presentedDigest]) =>
      crypto.subtle.timingSafeEqual(expectedDigest, presentedDigest),
    ),
  );
}
