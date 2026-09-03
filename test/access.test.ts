/// <reference types="@cloudflare/vitest-plugin/types" />

// The test deliberately builds varied claim dictionaries to exercise the untrusted JWT boundary.
// oxlint-disable anti-slop/no-unsafe-dictionary-type, typescript/no-misused-spread, eslint/max-lines-per-function

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  authenticateAccessRequest,
  deriveSupervisorName,
  verifyAccessToken,
} from "../src/access/index.js";
import type { VerifyAccessTokenInput } from "../src/access/index.js";

const issuer = "https://team.cloudflareaccess.com";
const audience = "access-application-id";
const now = 1_700_000_000;

type SigningAlgorithm = "RS256" | "ES256";

interface SigningKey {
  readonly algorithm: SigningAlgorithm;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

type TestClaims = {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly sub?: string;
};

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encode(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function isKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return "publicKey" in value && "privateKey" in value;
}

async function generateSigningPair(algorithm: SigningAlgorithm): Promise<CryptoKeyPair> {
  if (algorithm === "RS256") {
    const generated = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    if (!isKeyPair(generated)) {
      throw new Error("test key generation did not return a key pair");
    }
    return generated;
  }
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!isKeyPair(generated)) {
    throw new Error("test key generation did not return a key pair");
  }
  return generated;
}

async function signingKey(algorithm: SigningAlgorithm, kid: string): Promise<SigningKey> {
  const pair = await generateSigningPair(algorithm);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) {
    throw new TypeError("test key export did not return a JWK");
  }
  const publicJwk = Object.assign({}, exported, { kid });
  return {
    algorithm,
    privateKey: pair.privateKey,
    publicJwk,
  };
}

async function token(key: SigningKey, claims: TestClaims): Promise<string> {
  const encodedHeader = encode(JSON.stringify({ alg: key.algorithm, kid: key.publicJwk.kid }));
  const encodedClaims = encode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    key.algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  return `${encodedHeader}.${encodedClaims}.${encodeBytes(new Uint8Array(signature))}`;
}

function input(tokenValue: string, key: SigningKey): VerifyAccessTokenInput {
  return {
    token: tokenValue,
    issuer,
    audience,
    publicKeys: [key.publicJwk],
    now,
  };
}

async function validToken(
  algorithm: SigningAlgorithm,
  identity = "user-1",
): Promise<{ token: string; key: SigningKey }> {
  const key = await signingKey(algorithm, `${algorithm}-key`);
  const tokenValue = await token(key, {
    iss: issuer,
    aud: [audience],
    exp: now + 60,
    sub: identity,
  });
  return { token: tokenValue, key };
}

describe("Cloudflare Access JWT verification", () => {
  test.each(["RS256", "ES256"] as const)("accepts a valid %s token", async (algorithm) => {
    const signed = await validToken(algorithm);
    await expect(verifyAccessToken(input(signed.token, signed.key))).resolves.toEqual({
      ok: true,
      identity: "user-1",
    });
  });

  test("rejects a bad signature", async () => {
    const signed = await validToken("RS256");
    const parts = signed.token.split(".");
    const signature = parts[2] ?? "";
    // A fixed replacement character matches the original signature about one run in sixty-four.
    const changedFirst = signature.startsWith("A") ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${changedFirst}${signature.slice(1)}`;
    await expect(verifyAccessToken(input(tampered, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "invalid-signature",
    });
  });

  test("rejects a wrong issuer", async () => {
    const signed = await validToken("RS256");
    const wrongIssuer = await token(signed.key, {
      iss: "https://other.cloudflareaccess.com",
      aud: audience,
      exp: now + 60,
      sub: "user-1",
    });
    await expect(verifyAccessToken(input(wrongIssuer, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "wrong-issuer",
    });
  });

  test("rejects a wrong audience", async () => {
    const signed = await validToken("RS256");
    const wrongAudience = await token(signed.key, {
      iss: issuer,
      aud: ["other-application"],
      exp: now + 60,
      sub: "user-1",
    });
    await expect(verifyAccessToken(input(wrongAudience, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "wrong-audience",
    });
  });

  test("rejects an expired token", async () => {
    const signed = await validToken("RS256");
    const expired = await token(signed.key, {
      iss: issuer,
      aud: audience,
      exp: now,
      sub: "user-1",
    });
    await expect(verifyAccessToken(input(expired, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  test("rejects a token without the stable identity claim", async () => {
    const signed = await validToken("RS256");
    const missingIdentity = await token(signed.key, { iss: issuer, aud: audience, exp: now + 60 });
    await expect(verifyAccessToken(input(missingIdentity, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "missing-identity",
    });
  });

  test("rejects an unauthenticated request before configuration or routing", async () => {
    await expect(
      authenticateAccessRequest(
        new Request("https://cf-stumble.test/"),
        {
          CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CF_ACCESS_AUD: audience,
        },
        now,
      ),
    ).resolves.toEqual({ ok: false, reason: "malformed-token" });
  });

  test("the Worker rejects an unauthenticated request before Supervisor routing", async () => {
    // `SELF` is the plugin's Worker entry-point fixture in this repository.
    // oxlint-disable-next-line typescript/no-deprecated
    const response = await SELF.fetch(new Request("https://cf-stumble.test/"));
    expect(response.status).toBe(401);
  });
});

describe("Access-derived Supervisor names", () => {
  test("gives distinct identities distinct names", async () => {
    await expect(deriveSupervisorName({ identity: "user-1", audience })).not.resolves.toBe(
      await deriveSupervisorName({ identity: "user-2", audience }),
    );
  });

  test("keeps the same identity stable", async () => {
    await expect(deriveSupervisorName({ identity: "user-1", audience })).resolves.toBe(
      await deriveSupervisorName({ identity: "user-1", audience }),
    );
  });
});
