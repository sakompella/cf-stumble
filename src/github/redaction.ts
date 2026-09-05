/**
 * One place decides what a credential looks like in text, because redaction is only worth anything
 * if every surface agrees.
 *
 * Goal criterion 3 says a credential never appears in a tracked file, an application log, a
 * browser response, an R2 map, or saved facet state. Most of that is structural: no type that
 * crosses those boundaries has a token field, and the token a device authorization returns is
 * installed into the workspace and then dropped. This module covers the remaining path, which is
 * text a tool printed: `git` and `gh` write URLs and error messages, and a caller that forwards
 * that text unread would carry a token out of the workspace inside a diagnostic string.
 *
 * The patterns are GitHub's documented token prefixes plus the userinfo half of a URL, which is
 * how a token most often ends up quoted back by `git`. Redaction is a last line rather than the
 * design: a value that only survives because this function ran is a value in the wrong place.
 */

/** What a redacted credential reads as. Fixed text, so a test can assert on the whole string. */
export const REDACTED = "[redacted]";

/**
 * GitHub personal, OAuth, user-to-server, server-to-server, and refresh token prefixes, plus the
 * fine-grained `github_pat_` form. The length floor keeps the pattern from eating an ordinary
 * word that happens to start with one of the prefixes.
 */
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu;

/** The userinfo prefix of an HTTPS URL, which is how a credential reaches a message `git` prints. */
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu;

export function redactCredentials(text: string): string {
  return text
    .replaceAll(TOKEN_PATTERN, REDACTED)
    .replaceAll(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`);
}

/** Whether text still carries something credential-shaped. Tests assert the negative with it. */
export function containsCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}
