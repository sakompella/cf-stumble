export type SyntheticJwt = Readonly<{
  token: string;
  segments: readonly [header: string, payload: string, signature: string];
}>;

function base64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function syntheticJwt(): SyntheticJwt {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "synthetic-test-key" }));

  const payload = base64url(JSON.stringify({ sub: "synthetic-owner" }));

  const signature = base64url("synthetic signature, not a real one");

  return { token: `${header}.${payload}.${signature}`, segments: [header, payload, signature] };
}
