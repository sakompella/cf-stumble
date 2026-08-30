import { expect, test } from "vitest";
import { parseHarnessCommit } from "../src/harness-commit.js";

const validCommit = "0123456789abcdef0123456789abcdef01234567";

test("parses a 40-character lowercase hexadecimal harness commit", () => {
  expect(parseHarnessCommit(validCommit)).toBe(validCommit);
});

test.each([
  "",
  "main",
  "0123456789abcdef0123456789abcdef0123456",
  "0123456789abcdef0123456789abcdef012345678",
  "0123456789ABCDEF0123456789abcdef01234567",
  "g123456789abcdef0123456789abcdef01234567",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
])("rejects an invalid harness commit %j", (value) => {
  expect(parseHarnessCommit(value)).toBeUndefined();
});
