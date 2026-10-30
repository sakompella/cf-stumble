/**
 * Redaction is a last line rather than the design: no type that crosses a boundary has a token field.
 * This covers text a tool printed, since `git` and `gh` write URLs and error messages that can quote
 * a token.
 */

export const REDACTED = "[redacted]";

/** The length floor keeps the pattern from eating ordinary words that start with a prefix. */
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/gu;

/** The userinfo of an HTTPS URL is how a token most often ends up quoted back by `git`. */
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu;

/**
 * An opaque token accepted by `parseGitHubToken` has no recognizable shape, so the caller that sent
 * it strips it first.
 */
export function redactCredentials(text: string, knownToken?: string): string {
  const withKnownToken =
    knownToken !== undefined && knownToken.length > 0
      ? text.split(knownToken).join(REDACTED)
      : text;

  return withKnownToken
    .replaceAll(TOKEN_PATTERN, REDACTED)
    .replaceAll(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`);
}

export function containsCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}
