/**
 * A JWT-shaped string for redaction tests. Its three segments are base64url text, as in an Access
 * token, but the signature is fixed prose, so it is not a credential for any key. A test asserts
 * each segment is absent: a cut through a token can remove the whole token and still leave its
 * header or claims readable.
 */
export type SyntheticJwt = Readonly<{
  token: string;
  segments: readonly [header: string, payload: string, signature: string];
}>;

function base64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** `claimPadding` lengthens the payload, so a caller can build a token longer than a log limit. */
export function syntheticJwt(claimPadding = 0): SyntheticJwt {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "synthetic-test-key" }));

  const payload = base64url(
    JSON.stringify({ sub: "synthetic-owner", padding: "p".repeat(claimPadding) }),
  );

  const signature = base64url("synthetic signature, not a real one");

  return { token: `${header}.${payload}.${signature}`, segments: [header, payload, signature] };
}
