export const REDACTED = "[redacted]";

const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/gu;

const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu;

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
