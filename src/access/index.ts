/// <reference types="@cloudflare/workers-types" />

// This adapter parses untrusted key data before passing typed keys to the pure verifier.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof
import {
  deriveSupervisorName,
  verifyAccessToken,
  type AccessVerificationReason,
  type AccessVerificationResult,
  type VerifyAccessTokenInput,
} from "./verification.js";

export { deriveSupervisorName, verifyAccessToken } from "./verification.js";
export type {
  AccessIdentity,
  AccessVerificationReason,
  AccessVerificationResult,
  DeriveSupervisorNameInput,
  VerifyAccessTokenInput,
} from "./verification.js";

export interface AccessWorkerEnvironment {
  readonly CF_ACCESS_TEAM_DOMAIN: string;
  readonly CF_ACCESS_AUD: string;
  readonly CF_ACCESS_PUBLIC_KEYS?: string;
}

export type AccessRequestResult =
  | { readonly ok: true; readonly supervisorName: string }
  | { readonly ok: false; readonly reason: AccessVerificationReason | "invalid-configuration" };

type AccessFetch = typeof fetch;

interface CachedPublicKeys {
  readonly fetcher: AccessFetch;
  readonly url: string;
  readonly expiresAt: number;
  readonly keys: readonly JsonWebKey[];
}

const publicKeyCacheTtlMs = 5 * 60 * 1000;
let publicKeyCache: CachedPublicKeys | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicJwk(value: unknown): value is JsonWebKey {
  if (!isRecord(value) || typeof value.kty !== "string") {
    return false;
  }
  if (value.alg !== undefined && value.alg !== "RS256" && value.alg !== "ES256") {
    return false;
  }
  if (value.use !== undefined && value.use !== "sig") {
    return false;
  }
  if (value.kid !== undefined && (typeof value.kid !== "string" || value.kid.length === 0)) {
    return false;
  }

  if (value.kty === "RSA") {
    return (
      typeof value.n === "string" &&
      value.n.length > 0 &&
      typeof value.e === "string" &&
      value.e.length > 0
    );
  }
  if (value.kty === "EC") {
    return (
      value.crv === "P-256" &&
      typeof value.x === "string" &&
      value.x.length > 0 &&
      typeof value.y === "string" &&
      value.y.length > 0
    );
  }
  return false;
}

function parsePublicKeys(value: unknown): readonly JsonWebKey[] | undefined {
  const keys = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.keys)
      ? value.keys
      : undefined;
  return keys !== undefined && keys.length > 0 && keys.every((item) => isPublicJwk(item))
    ? keys
    : undefined;
}

function parseSerializedPublicKeys(serialized: string): readonly JsonWebKey[] | undefined {
  try {
    return parsePublicKeys(JSON.parse(serialized));
  } catch {
    return undefined;
  }
}

function issuerForTeamDomain(teamDomain: string): string | undefined {
  const domain = teamDomain.trim().replace(/\/+$/u, "");
  if (domain.length === 0) {
    return undefined;
  }
  return domain.startsWith("https://") || domain.startsWith("http://")
    ? domain
    : `https://${domain}`;
}

function certsUrl(issuer: string): string | undefined {
  try {
    return new URL("/cdn-cgi/access/certs", issuer).toString();
  } catch {
    return undefined;
  }
}

async function fetchPublicKeys(
  url: string,
  fetcher: AccessFetch,
  forceRefresh: boolean,
): Promise<readonly JsonWebKey[] | undefined> {
  const now = Date.now();
  if (
    !forceRefresh &&
    publicKeyCache !== undefined &&
    publicKeyCache.fetcher === fetcher &&
    publicKeyCache.url === url &&
    publicKeyCache.expiresAt > now
  ) {
    return publicKeyCache.keys;
  }

  try {
    const response = await fetcher(url);
    if (!response.ok) {
      return undefined;
    }
    const keys = parsePublicKeys(await response.json());
    if (keys === undefined) {
      return undefined;
    }
    publicKeyCache = { fetcher, url, expiresAt: now + publicKeyCacheTtlMs, keys };
    return keys;
  } catch {
    return undefined;
  }
}

function tokenKeyId(token: string): string | undefined {
  const encodedHeader = token.split(".")[0];
  if (encodedHeader === undefined) {
    return undefined;
  }
  try {
    const base64 = encodedHeader.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const decoded: unknown = JSON.parse(atob(padded));
    return isRecord(decoded) && typeof decoded.kid === "string" ? decoded.kid : undefined;
  } catch {
    return undefined;
  }
}

type BoundaryVerificationResult =
  | AccessVerificationResult
  | { readonly ok: false; readonly reason: "invalid-configuration" };

async function verifyUsingAccessKeys(
  input: VerifyAccessTokenInput,
  explicitKeys: readonly JsonWebKey[] | undefined,
  url: string | undefined,
  fetcher: AccessFetch,
  webCrypto: Crypto,
): Promise<BoundaryVerificationResult> {
  const parsed = await verifyAccessToken(input, webCrypto);
  if (!parsed.ok && parsed.reason !== "invalid-signature") {
    return parsed;
  }

  let publicKeys = explicitKeys;
  if (publicKeys === undefined) {
    if (url === undefined) {
      return { ok: false, reason: "invalid-configuration" };
    }
    publicKeys = await fetchPublicKeys(url, fetcher, false);
  }
  if (publicKeys === undefined) {
    return { ok: false, reason: "invalid-signature" };
  }

  let verified = await verifyAccessToken({ ...input, publicKeys }, webCrypto);
  if (
    !verified.ok &&
    explicitKeys === undefined &&
    url !== undefined &&
    verified.reason === "invalid-signature" &&
    !hasMatchingKid(publicKeys, input.token)
  ) {
    const refreshedKeys = await fetchPublicKeys(url, fetcher, true);
    if (refreshedKeys === undefined) {
      return { ok: false, reason: "invalid-signature" };
    }
    verified = await verifyAccessToken({ ...input, publicKeys: refreshedKeys }, webCrypto);
  }
  return verified;
}

function hasMatchingKid(publicKeys: readonly JsonWebKey[], token: string): boolean {
  const kid = tokenKeyId(token);
  return kid !== undefined && publicKeys.some((key) => isRecord(key) && key.kid === kid);
}

interface AccessConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly explicitKeys: readonly JsonWebKey[] | undefined;
  readonly certsUrl: string | undefined;
}

function accessConfiguration(env: AccessWorkerEnvironment): AccessConfiguration | undefined {
  if (
    typeof env.CF_ACCESS_TEAM_DOMAIN !== "string" ||
    typeof env.CF_ACCESS_AUD !== "string" ||
    env.CF_ACCESS_AUD.length === 0
  ) {
    return undefined;
  }
  const issuer = issuerForTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (issuer === undefined) {
    return undefined;
  }
  const explicitKeys =
    env.CF_ACCESS_PUBLIC_KEYS === undefined
      ? undefined
      : parseSerializedPublicKeys(env.CF_ACCESS_PUBLIC_KEYS);
  if (env.CF_ACCESS_PUBLIC_KEYS !== undefined && explicitKeys === undefined) {
    return undefined;
  }
  return {
    issuer,
    audience: env.CF_ACCESS_AUD,
    explicitKeys,
    certsUrl: certsUrl(issuer),
  };
}

export async function authenticateAccessRequest(
  request: Request,
  env: AccessWorkerEnvironment,
  now = Math.floor(Date.now() / 1000),
  webCrypto: Crypto = crypto,
  fetcher: AccessFetch = fetch,
): Promise<AccessRequestResult> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null) {
    return { ok: false, reason: "malformed-token" };
  }
  const configuration = accessConfiguration(env);
  if (configuration === undefined) {
    return { ok: false, reason: "invalid-configuration" };
  }

  const verified = await verifyUsingAccessKeys(
    {
      token,
      issuer: configuration.issuer,
      audience: configuration.audience,
      publicKeys: [],
      now,
    },
    configuration.explicitKeys,
    configuration.certsUrl,
    fetcher,
    webCrypto,
  );
  if (!verified.ok) {
    return verified;
  }

  return {
    ok: true,
    supervisorName: await deriveSupervisorName(
      { identity: verified.identity, audience: configuration.audience },
      webCrypto,
    ),
  };
}
