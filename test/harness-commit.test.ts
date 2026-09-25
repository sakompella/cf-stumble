import { expect, test } from "vitest";
import { parseHarnessCommit } from "../src/harness-commit.js";

const validSha1Commit = "0123456789abcdef0123456789abcdef01234567";

test("parses a lowercase hexadecimal SHA-1 harness commit", () => {
  expect(parseHarnessCommit(validSha1Commit)).toBe(validSha1Commit);
});

test.each([
  ["invalid length", "0123456789abcdef0123456789abcdef0123456"],
  ["uppercase", "0123456789ABCDEF0123456789abcdef01234567"],
  ["non-hex", "g123456789abcdef0123456789abcdef01234567"],
])("rejects a harness commit with %s", (_rule, value) => {
  expect(parseHarnessCommit(value)).toBeUndefined();
});
