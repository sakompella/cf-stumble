import { mkdir, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

/**
 * Mint a throwaway Cloudflare Access session for local runs and browser testing.
 *
 * The deployed Worker verifies a real Access token against the team JWKS. Access does not sit in
 * front of `wrangler dev`, so this script generates one disposable signing key, records its public
 * JWK for `CF_ACCESS_PUBLIC_KEYS`, and mints one token signed by it. The Worker then runs its
 * ordinary verification: the same signature, issuer, audience, expiry and identity checks. This
 * adds no bypass to the Worker, and it touches no production key.
 */

const TEAM_DOMAIN = process.env.LOCAL_ACCESS_TEAM_DOMAIN ?? "local-dev.cloudflareaccess.com";
const AUDIENCE = process.env.LOCAL_ACCESS_AUD ?? "local-development-audience";
const SUBJECT = process.env.LOCAL_ACCESS_SUB ?? "local-owner";
const LIFETIME_SECONDS = 8 * 60 * 60;
const KEY_ID = "local-dev-key";
const OUTPUT_PATH = ".audit/local/access-session.json";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

type TokenHeader = Readonly<{ alg: "ES256"; kid: string; typ: "JWT" }>;

type TokenClaims = Readonly<{
  iss: string;
  aud: readonly string[];
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
}>;

function encodeSegment(value: TokenHeader | TokenClaims): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
const publicKeys = {
  keys: [
    {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
      alg: "ES256",
      use: "sig",
      kid: KEY_ID,
    },
  ],
};

const issuedAt = Math.floor(Date.now() / 1000);
const header = encodeSegment({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
const claims = encodeSegment({
  iss: `https://${TEAM_DOMAIN}`,
  aud: [AUDIENCE],
  sub: SUBJECT,
  iat: issuedAt,
  nbf: issuedAt,
  exp: issuedAt + LIFETIME_SECONDS,
});
const signature = await webcrypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  keyPair.privateKey,
  new TextEncoder().encode(`${header}.${claims}`),
);

const session = {
  teamDomain: TEAM_DOMAIN,
  audience: AUDIENCE,
  subject: SUBJECT,
  expiresAt: issuedAt + LIFETIME_SECONDS,
  publicKeys: JSON.stringify(publicKeys),
  token: `${header}.${claims}.${base64Url(new Uint8Array(signature))}`,
};

await mkdir(".audit/local", { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(session, undefined, 2)}\n`);

console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`Team domain: ${session.teamDomain}`);
console.log(`Audience:    ${session.audience}`);
console.log(`Subject:     ${session.subject}`);
console.log("The token stays in that ignored file. Send it as the Cf-Access-Jwt-Assertion header,");
console.log("or as the CF_Authorization cookie once the Worker accepts the cookie.");
