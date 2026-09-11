/// <reference types="@cloudflare/workers-types" />

// JWT parsing is the trust boundary. These checks intentionally validate unknown token data.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, typescript/no-redundant-type-constituents
import type { AccessPublicKey } from "./keys.js";

/** The only token field used to route an authenticated request. */
export type AccessIdentity = string;

export type AccessVerificationReason =
  | "malformed-token"
  | "unsupported-algorithm"
  | "invalid-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "invalid-expiry"
  | "expired"
  | "not-yet-valid"
  | "missing-identity";

export type AccessVerificationResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: AccessVerificationReason };

export interface VerifyAccessTokenInput {
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: readonly AccessPublicKey[];
  /** Current Unix time in seconds. JWT `exp` and `nbf` use the same unit. */
  readonly now: number;
}

interface JwtHeader {
  readonly alg: "RS256" | "ES256";
  readonly kid?: string;
}

interface JwtClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly sub: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePart(part: string): Uint8Array | undefined {
  if (part.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(part) || part.length % 4 === 1) {
    return undefined;
  }

  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

  try {
    const decoded = atob(padded);

    return Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

function decodeJson(part: string): unknown | undefined {
  const bytes = decodePart(part);

  if (bytes === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

function parseHeader(value: unknown): JwtHeader | undefined {
  if (!isRecord(value) || (value.alg !== "RS256" && value.alg !== "ES256")) {
    return undefined;
  }

  if (value.kid !== undefined && typeof value.kid !== "string") {
    return undefined;
  }

  return value.kid === undefined ? { alg: value.alg } : { alg: value.alg, kid: value.kid };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseClaims(
  value: unknown,
):
  | { readonly ok: true; readonly claims: JwtClaims }
  | { readonly ok: false; readonly reason: AccessVerificationReason } {
  if (!isRecord(value) || typeof value.iss !== "string") {
    return { ok: false, reason: "wrong-issuer" };
  }

  if (typeof value.aud !== "string" && !isStringArray(value.aud)) {
    return { ok: false, reason: "wrong-audience" };
  }

  if (!isFiniteNumber(value.exp)) {
    return { ok: false, reason: "invalid-expiry" };
  }

  if (value.nbf !== undefined && !isFiniteNumber(value.nbf)) {
    return { ok: false, reason: "not-yet-valid" };
  }

  if (typeof value.sub !== "string" || value.sub.length === 0) {
    return { ok: false, reason: "missing-identity" };
  }

  return {
    ok: true,
    claims:
      value.nbf === undefined
        ? { iss: value.iss, aud: value.aud, exp: value.exp, sub: value.sub }
        : { iss: value.iss, aud: value.aud, exp: value.exp, nbf: value.nbf, sub: value.sub },
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function keyMatches(key: AccessPublicKey, header: JwtHeader): boolean {
  if (key.kid !== undefined && key.kid !== header.kid) {
    return false;
  }

  if (key.alg !== undefined && key.alg !== header.alg) {
    return false;
  }

  if (key.use !== undefined && key.use !== "sig") {
    return false;
  }

  return header.alg === "RS256" ? key.kty === "RSA" : key.kty === "EC" && key.crv === "P-256";
}

async function verifiesKey(
  header: JwtHeader,
  signingInput: string,
  signature: Uint8Array,
  publicKey: AccessPublicKey,
  crypto: Crypto,
): Promise<boolean> {
  try {
    if (header.alg === "RS256") {
      const key = await crypto.subtle.importKey(
        "jwk",
        publicKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );

      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        signature,
        new TextEncoder().encode(signingInput),
      );
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    // A malformed configured key is indistinguishable from a failed signature at this boundary.
    return false;
  }
}

async function verifiesSignature(
  header: JwtHeader,
  signingInput: string,
  signature: Uint8Array,
  publicKeys: readonly AccessPublicKey[],
  crypto: Crypto,
): Promise<boolean> {
  for (const publicKey of publicKeys) {
    if (
      keyMatches(publicKey, header) &&
      (await verifiesKey(header, signingInput, signature, publicKey, crypto))
    ) {
      return true;
    }
  }

  return false;
}

type ParsedToken = {
  readonly header: JwtHeader;
  readonly claimsPart: string;
  readonly signature: Uint8Array;
  readonly signingInput: string;
};

type TokenParsingResult =
  | { readonly ok: true; readonly token: ParsedToken }
  | { readonly ok: false; readonly reason: "malformed-token" | "unsupported-algorithm" };

function parseToken(token: string): TokenParsingResult {
  const parts = token.split(".");

  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { ok: false, reason: "malformed-token" };
  }

  const encodedHeader = parts[0];
  const claimsPart = parts[1];
  const encodedSignature = parts[2];

  if (encodedHeader === undefined || claimsPart === undefined || encodedSignature === undefined) {
    return { ok: false, reason: "malformed-token" };
  }

  const decodedHeader = decodeJson(encodedHeader);
  const header = parseHeader(decodedHeader);

  if (header === undefined) {
    return {
      ok: false,
      reason:
        isRecord(decodedHeader) && typeof decodedHeader.alg === "string"
          ? "unsupported-algorithm"
          : "malformed-token",
    };
  }

  const signature = decodePart(encodedSignature);

  return signature === undefined
    ? { ok: false, reason: "malformed-token" }
    : {
        ok: true,
        token: { header, claimsPart, signature, signingInput: `${encodedHeader}.${claimsPart}` },
      };
}

export async function verifyAccessToken(
  input: VerifyAccessTokenInput,
  webCrypto: Crypto = crypto,
): Promise<AccessVerificationResult> {
  const parsedToken = parseToken(input.token);

  if (!parsedToken.ok) {
    return parsedToken;
  }

  if (
    !(await verifiesSignature(
      parsedToken.token.header,
      parsedToken.token.signingInput,
      parsedToken.token.signature,
      input.publicKeys,
      webCrypto,
    ))
  ) {
    return { ok: false, reason: "invalid-signature" };
  }

  const parsedClaims = parseClaims(decodeJson(parsedToken.token.claimsPart));

  if (!parsedClaims.ok) {
    return parsedClaims;
  }

  const { claims } = parsedClaims;

  if (claims.iss !== input.issuer) {
    return { ok: false, reason: "wrong-issuer" };
  }

  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;

  if (!audiences.includes(input.audience)) {
    return { ok: false, reason: "wrong-audience" };
  }

  if (input.now >= claims.exp) {
    return { ok: false, reason: "expired" };
  }

  if (claims.nbf !== undefined && input.now < claims.nbf) {
    return { ok: false, reason: "not-yet-valid" };
  }

  return { ok: true, identity: claims.sub };
}

export interface DeriveSupervisorNameInput {
  readonly identity: AccessIdentity;
  readonly audience: string;
}

export async function deriveSupervisorName(
  input: DeriveSupervisorNameInput,
  webCrypto: Crypto = crypto,
): Promise<string> {
  const value = new TextEncoder().encode(`${input.identity}\u0000${input.audience}`);
  const digest = await webCrypto.subtle.digest("SHA-256", value);
  const bytes = new Uint8Array(digest);
  const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `access:${hash}`;
}
