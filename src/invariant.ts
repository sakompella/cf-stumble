/**
 * Assert an internal invariant that must hold if the code is correct. A failure means a broken
 * build-time constant or a caller precondition violation, not a recoverable runtime condition, so
 * this throws rather than returning a Result (ADR-0035). Use it to name "should never happen"
 * checks; keep Result for expected failures, and keep the persistence decoders' own throws for
 * corrupt stored data.
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
