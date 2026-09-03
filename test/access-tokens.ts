/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Access tokens for tests. Every Access test needs a real signature over real claims, because a
 * fake verifier would prove nothing about the boundary. Keys are generated in the test process,
 * so no test reaches the network.
 */

export const accessIssuer = "https://team.cloudflareaccess.com";
export const accessAudience = "access-application-id";
export const accessNow = 1_700_000_000;
/** The `sub` claim every Access test environment configures as `CF_ACCESS_OWNER_SUB`. */
export const accessOwnerSubject = "owner-1";

export type SigningAlgorithm = "RS256" | "ES256";

export interface SigningKey {
  readonly algorithm: SigningAlgorithm;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { readonly kid: string };
}

export type TestClaims = {
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
  const generated =
    algorithm === "RS256"
      ? await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign", "verify"],
        )
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
          "sign",
          "verify",
        ]);
  if (!isKeyPair(generated)) {
    throw new Error("test key generation did not return a key pair");
  }
  return generated;
}

export async function signingKey(
  kid: string,
  algorithm: SigningAlgorithm = "RS256",
): Promise<SigningKey> {
  const pair = await generateSigningPair(algorithm);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) {
    throw new TypeError("test key export did not return a JWK");
  }
  return {
    algorithm,
    privateKey: pair.privateKey,
    publicJwk: Object.assign({}, exported, { kid }),
  };
}

export async function signAccessToken(key: SigningKey, claims: TestClaims): Promise<string> {
  const encodedHeader = encode(JSON.stringify({ alg: key.algorithm, kid: key.publicJwk.kid }));
  const encodedClaims = encode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    key.algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  return `${encodedHeader}.${encodedClaims}.${encodeBytes(new Uint8Array(signature))}`;
}
