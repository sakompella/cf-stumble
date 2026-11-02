import { expect, test } from "vitest";
import { redactCredentials } from "../../src/github/index.js";
import { containsCredential } from "../../src/github/redaction.js";

test("leaves ordinary text alone, so a redacted message still explains the failure", () => {
  const message = "fatal: repository 'https://github.com/owner/repo' not found";

  expect(redactCredentials(message)).toBe(message);
  expect(containsCredential(message)).toBe(false);
  expect(containsCredential("the word ghost is not a token")).toBe(false);
});
