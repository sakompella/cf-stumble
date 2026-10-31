export type SyntheticJwt = Readonly<{
  token: string;
  segments: readonly [header: string, payload: string, signature: string];
}>;

function base64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function syntheticJwt(claimPadding = 0): SyntheticJwt {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "synthetic-test-key" }));

  const payload = base64url(
    JSON.stringify({ sub: "synthetic-owner", padding: "p".repeat(claimPadding) }),
  );

  const signature = base64url("synthetic signature, not a real one");

  return { token: `${header}.${payload}.${signature}`, segments: [header, payload, signature] };
}
