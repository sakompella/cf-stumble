/**
 * Throws rather than returning a Result: a failure is a broken constant or caller bug, not a
 * recoverable condition.
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
