import { parseHarnessCommit, type HarnessCommit } from "../src/harness-commit.js";

export function testHarnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);

  if (parsed === undefined) {
    throw new Error("the test commit must be a valid harness commit");
  }

  return parsed;
}
