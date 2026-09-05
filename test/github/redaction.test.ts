import { expect, test } from "vitest";
import { containsCredential, redactCredentials, REDACTED } from "../../src/github/index.js";

/**
 * Redaction is the last line, not the design: nothing in cf-stumble puts a token in a value that
 * crosses a boundary. What this covers is the text `git` and `gh` print, which is the one place a
 * credential can arrive from outside and be forwarded without being read.
 */

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

test.each([
  ["ghp_cfstumbleFAKEtokenFAKEtoken0123456789", "a personal access token"],
  ["gho_cfstumbleFAKEtokenFAKEtoken0123456789", "an OAuth token"],
  ["ghu_cfstumbleFAKEtokenFAKEtoken0123456789", "a user-to-server token"],
  ["ghs_cfstumbleFAKEtokenFAKEtoken0123456789", "a server-to-server token"],
  ["ghr_cfstumbleFAKEtokenFAKEtoken0123456789", "a refresh token"],
  ["github_pat_cfstumbleFAKE_tokenFAKEtoken0123456789", "a fine-grained token"],
])("removes %s (%s) from text", (token) => {
  const message = `fatal: authentication failed using ${token} at github.com`;

  const redacted = redactCredentials(message);

  expect(redacted).not.toContain(token);
  expect(redacted).toContain(REDACTED);
  expect(containsCredential(message)).toBe(true);
  expect(containsCredential(redacted)).toBe(false);
});

test("removes the credential half of a URL, which is how git quotes one back", () => {
  const message = `remote: https://x-access-token:${FAKE_TOKEN}@github.com/owner/repo.git failed`;

  const redacted = redactCredentials(message);

  expect(redacted).toBe(`remote: https://${REDACTED}@github.com/owner/repo.git failed`);
  expect(redacted).not.toContain(FAKE_TOKEN);
});

test("leaves ordinary text alone, so a redacted message still explains the failure", () => {
  const message = "fatal: repository 'https://github.com/owner/repo' not found";

  expect(redactCredentials(message)).toBe(message);
  expect(containsCredential(message)).toBe(false);
  expect(containsCredential("the word ghost is not a token")).toBe(false);
});
