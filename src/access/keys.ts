/// <reference types="@cloudflare/workers-types" />

// The JWKS document is untrusted input, so keys are parsed before the verifier ever sees them.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
import { Result } from "better-result";
import { logRedactedCause } from "../diagnostics.js";

export type AccessFetch = typeof fetch;

/**
 * Why a JWKS load produced no keys: the certs endpoint rejected, answered a non-2xx status, or
 * answered a body that did not parse into a usable key set. A caller cannot and should not tell
 * these apart (ADR-0035); every one of them is Cloudflare Access's key service, not the presented
 * token, so `verifyUsingAccessKeys` turns this into a public `key-service-unavailable` reason
 * rather than folding it into `invalid-signature`. The cause itself is logged for operators at the
 * point it is discarded, not carried on this value.
 */
export type KeyLoadFailure = Readonly<{ code: "key-service-unavailable" }>;

/**
 * A signing key this module accepted. `JsonWebKey` in workers-types has no `kid`, and Access
 * publishes one per key, so the parsed type carries the field the verifier reads. The parser
 * below is the only place that decides a `kid` is a non-empty string.
 */
export interface AccessPublicKey extends JsonWebKey {
  readonly kid?: string;
}

interface CachedPublicKeys {
  readonly fetcher: AccessFetch;
  readonly url: string;
  readonly expiresAt: number;
  readonly keys: readonly AccessPublicKey[];
}

const publicKeyCacheTtlMs = 5 * 60 * 1000;

const publicKeyRefreshCooldownMs = 30 * 1000;

let publicKeyCache: CachedPublicKeys | undefined;

let publicKeyRefreshAllowedAt = 0;

let publicKeyFetchInFlight: Promise<Result<readonly AccessPublicKey[], KeyLoadFailure>> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicJwk(value: unknown): value is AccessPublicKey {
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

export function parsePublicKeys(value: unknown): readonly AccessPublicKey[] | undefined {
  const keys = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.keys)
      ? value.keys
      : undefined;

  return keys !== undefined && keys.length > 0 && keys.every((item) => isPublicJwk(item))
    ? keys
    : undefined;
}

export function parseSerializedPublicKeys(
  serialized: string,
): readonly AccessPublicKey[] | undefined {
  try {
    return parsePublicKeys(JSON.parse(serialized));
  } catch {
    return undefined;
  }
}

export function issuerForTeamDomain(teamDomain: string): string | undefined {
  const domain = teamDomain.trim().replace(/\/+$/u, "");

  if (domain.length === 0 || domain.startsWith("http://")) {
    return undefined;
  }

  // Trust keys are fetched from this origin, so an unauthenticated transport would let an
  // on-path attacker supply a signing key.
  const candidate = domain.startsWith("https://") ? domain : `https://${domain}`;

  try {
    const url = new URL(candidate);

    return url.protocol === "https:" && url.hostname.includes(".") ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function certsUrl(issuer: string): string | undefined {
  try {
    return new URL("/cdn-cgi/access/certs", issuer).toString();
  } catch {
    return undefined;
  }
}

function cachedPublicKeys(
  url: string,
  fetcher: AccessFetch,
  now: number,
): readonly AccessPublicKey[] | undefined {
  return publicKeyCache !== undefined &&
    publicKeyCache.fetcher === fetcher &&
    publicKeyCache.url === url &&
    publicKeyCache.expiresAt > now
    ? publicKeyCache.keys
    : undefined;
}

async function loadPublicKeys(
  url: string,
  fetcher: AccessFetch,
): Promise<Result<readonly AccessPublicKey[], KeyLoadFailure>> {
  try {
    const response = await fetcher(url);

    if (!response.ok) {
      logRedactedCause(
        "access-keys.load: key-service-unavailable",
        `unexpected JWKS response status ${response.status}`,
      );

      return Result.err({ code: "key-service-unavailable" });
    }

    const keys = parsePublicKeys(await response.json());

    if (keys === undefined) {
      logRedactedCause(
        "access-keys.load: key-service-unavailable",
        "JWKS response body did not parse into a usable key set",
      );

      return Result.err({ code: "key-service-unavailable" });
    }

    publicKeyCache = { fetcher, url, expiresAt: Date.now() + publicKeyCacheTtlMs, keys };

    return Result.ok(keys);
  } catch (cause) {
    logRedactedCause("access-keys.load: key-service-unavailable", cause);

    return Result.err({ code: "key-service-unavailable" });
  }
}

/**
 * An unverified token names its own key, so a refresh must never be one fetch per request.
 * Concurrent callers share one request and a rejected key id cannot force the next one.
 */
export function fetchPublicKeys(
  url: string,
  fetcher: AccessFetch,
  forceRefresh: boolean,
): Promise<Result<readonly AccessPublicKey[], KeyLoadFailure>> {
  const now = Date.now();
  const cached = cachedPublicKeys(url, fetcher, now);

  if (cached !== undefined && (!forceRefresh || now < publicKeyRefreshAllowedAt)) {
    return Promise.resolve(Result.ok(cached));
  }

  if (publicKeyFetchInFlight === undefined) {
    if (forceRefresh) {
      publicKeyRefreshAllowedAt = now + publicKeyRefreshCooldownMs;
    }

    publicKeyFetchInFlight = loadPublicKeys(url, fetcher).finally(() => {
      publicKeyFetchInFlight = undefined;
    });
  }

  return publicKeyFetchInFlight;
}
