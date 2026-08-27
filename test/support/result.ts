import { expect } from "vitest";
import { Result } from "better-result";

/**
 * Narrow a `Result` to its success value, failing the test with the error's message when it is not
 * one. Assertion helpers rather than `unwrap()` so a wrong branch reports as a failed expectation
 * instead of a Panic thrown from library code.
 */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (Result.isError(result)) {
    const error = result.error;
    expect.fail(
      `expected Ok, got Err: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
  if (Result.isOk(result)) {
    expect.fail(`expected Err, got Ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
