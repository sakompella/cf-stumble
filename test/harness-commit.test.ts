import { expect, test } from "vitest";
import { parseHarnessCommit } from "../src/harness-commit.js";

const validSha1Commit = "0123456789abcdef0123456789abcdef01234567";

const validSha256Commit = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test.each([validSha1Commit, validSha256Commit])(
  "parses a lowercase hexadecimal harness commit %j",
  (commit) => {
    expect(parseHarnessCommit(commit)).toBe(commit);
  },
);

test.each([
  "",
  "main",
  "0123456789abcdef0123456789abcdef0123456",
  "0123456789abcdef0123456789abcdef012345678",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
  "0123456789ABCDEF0123456789abcdef01234567",
  "g123456789abcdef0123456789abcdef01234567",
])("rejects an invalid harness commit %j", (value) => {
  expect(parseHarnessCommit(value)).toBeUndefined();
});
