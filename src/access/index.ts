/// <reference types="@cloudflare/workers-types" />

// This adapter turns a verified token into the one name the Supervisor is addressed by.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof
import { presentedAccessToken } from "./credentials.js";
import {
  certsUrl,
  fetchPublicKeys,
  issuerForTeamDomain,
  parseSerializedPublicKeys,
  type AccessFetch,
} from "./keys.js";
import {
  deriveSupervisorName,
  verifyAccessToken,
  type AccessVerificationReason,
  type AccessVerificationResult,
  type VerifyAccessTokenInput,
} from "./verification.js";

export { presentedAccessToken, withoutAccessCredentials } from "./credentials.js";
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
  readonly CF_ACCESS_OWNER_SUB: string;
}

export type AccessRequestResult =
  | { readonly ok: true; readonly supervisorName: string }
  | {
      readonly ok: false;
      readonly reason: AccessVerificationReason | "invalid-configuration" | "not-owner";
    };

// A missing, empty, or whitespace-only secret is indistinguishable from misconfiguration: this
// Worker has exactly one owner, and there is no safe default identity to fall back to.
function configuredOwnerSubject(env: AccessWorkerEnvironment): string | undefined {
  if (typeof env.CF_ACCESS_OWNER_SUB !== "string") {
    return undefined;
  }
  const subject = env.CF_ACCESS_OWNER_SUB.trim();
  return subject.length > 0 ? subject : undefined;
}

// Runs on a verified identity, but strictly before a Supervisor name is ever derived for it, so a
// non-owner request never causes a Durable Object to be named or created.
function ownerVerificationFailure(
  env: AccessWorkerEnvironment,
  identity: string,
): { readonly ok: false; readonly reason: "invalid-configuration" | "not-owner" } | undefined {
  const ownerSubject = configuredOwnerSubject(env);
  if (ownerSubject === undefined) {
    return { ok: false, reason: "invalid-configuration" };
  }
  return identity === ownerSubject ? undefined : { ok: false, reason: "not-owner" };
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
  return kid !== undefined && publicKeys.some((key) => keyId(key) === kid);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyId(key: JsonWebKey): string | undefined {
  const record: unknown = key;
  return isRecord(record) && typeof record.kid === "string" ? record.kid : undefined;
}

export async function authenticateAccessRequest(
  request: Request,
  env: AccessWorkerEnvironment,
  now = Math.floor(Date.now() / 1000),
  webCrypto: Crypto = crypto,
  fetcher: AccessFetch = fetch,
): Promise<AccessRequestResult> {
  // An absent credential and an unusable one are the same failure: no verified identity.
  const token = presentedAccessToken(request);
  if (token === undefined) {
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

  const ownerFailure = ownerVerificationFailure(env, verified.identity);
  if (ownerFailure !== undefined) {
    return ownerFailure;
  }

  return {
    ok: true,
    supervisorName: await deriveSupervisorName(
      { identity: verified.identity, audience: configuration.audience },
      webCrypto,
    ),
  };
}
