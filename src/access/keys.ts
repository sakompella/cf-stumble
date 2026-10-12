// The JWKS document is untrusted input, so keys are parsed before the verifier ever sees them.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { logRedactedCause } from "../diagnostics.js";

export type AccessFetch = typeof fetch;

/**
 * Cloudflare Access's key service produced no keys: the certs endpoint rejected, answered a non-2xx
 * status, or answered a body that did not parse into a usable key set. A caller cannot and should
 * not tell these apart; every one of them is the key service, not the presented token, so the
 * boundary reports `key-service-unavailable` rather than folding it into `invalid-signature`. The
 * cause is logged for operators where it is discarded, not carried here.
 */
export class KeyServiceUnavailable extends Data.TaggedError("KeyServiceUnavailable") {
  get reason(): "key-service-unavailable" {
    return "key-service-unavailable";
  }
}

/**
 * A signing key this module accepted. `JsonWebKey` in workers-types has no `kid`, and Access
 * publishes one per key, so the parsed type carries the field the verifier reads. `PublicJwk`
 * below is the only place that decides a `kid` is a non-empty string.
 */
export interface AccessPublicKey extends JsonWebKey {
  readonly kid?: string;
}

const signingKeyFields = {
  alg: Schema.optionalKey(Schema.Literals(["RS256", "ES256"])),
  use: Schema.optionalKey(Schema.Literal("sig")),
  kid: Schema.optionalKey(Schema.NonEmptyString),
};

const PublicJwk = Schema.Union([
  Schema.Struct({
    ...signingKeyFields,
    kty: Schema.Literal("RSA"),
    n: Schema.NonEmptyString,
    e: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...signingKeyFields,
    kty: Schema.Literal("EC"),
    crv: Schema.Literal("P-256"),
    x: Schema.NonEmptyString,
    y: Schema.NonEmptyString,
  }),
]);

const PublicJwks = Schema.NonEmptyArray(PublicJwk);

const KeySetDocument = Schema.Union([PublicJwks, Schema.Struct({ keys: PublicJwks })]);

// `Schema.is` checks the document without rebuilding it: a decode would strip fields such as
// `key_ops` and `ext` that `crypto.subtle.importKey` still enforces.
const isKeySetDocument = Schema.is(KeySetDocument);

const isKeyList = Schema.is(PublicJwks);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: a JWKS document is untrusted JSON.
function parsePublicKeys(document: unknown): readonly AccessPublicKey[] | undefined {
  if (!isKeySetDocument(document)) {
    return undefined;
  }

  return isKeyList(document) ? document : document.keys;
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

/**
 * The one key load in progress, shared by every request this isolate is serving. It is a native
 * Promise rather than a fiber or a `Deferred` on purpose. A request that awaits a Promise resumes
 * in its own request context; a fiber that another request's fiber resumed would run the rest of
 * this request, including its Supervisor call, from inside that other request.
 */
let publicKeyFetchInFlight: Promise<readonly AccessPublicKey[] | undefined> | undefined;

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

/** Fetch and parse the key set once. A failure is logged here, once per load, and is `undefined`. */
async function loadPublicKeys(
  url: string,
  fetcher: AccessFetch,
): Promise<readonly AccessPublicKey[] | undefined> {
  try {
    const response = await fetcher(url);

    if (!response.ok) {
      logRedactedCause(
        "access-keys.load: key-service-unavailable",
        `unexpected JWKS response status ${response.status}`,
      );

      return undefined;
    }

    const keys = parsePublicKeys(await response.json());

    if (keys === undefined) {
      logRedactedCause(
        "access-keys.load: key-service-unavailable",
        "JWKS response body did not parse into a usable key set",
      );

      return undefined;
    }

    publicKeyCache = { fetcher, url, expiresAt: Date.now() + publicKeyCacheTtlMs, keys };

    return keys;
  } catch (cause) {
    logRedactedCause("access-keys.load: key-service-unavailable", cause);

    return undefined;
  }
}

function sharedKeyLoad(
  url: string,
  fetcher: AccessFetch,
  forceRefresh: boolean,
): Promise<readonly AccessPublicKey[] | undefined> {
  const now = Date.now();
  const cached = cachedPublicKeys(url, fetcher, now);

  if (cached !== undefined && (!forceRefresh || now < publicKeyRefreshAllowedAt)) {
    return Promise.resolve(cached);
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

/**
 * An unverified token names its own key, so a refresh must never be one fetch per request.
 * Concurrent callers share one request and a rejected key id cannot force the next one.
 */
export function fetchPublicKeys(
  url: string,
  fetcher: AccessFetch,
  forceRefresh: boolean,
): Effect.Effect<readonly AccessPublicKey[], KeyServiceUnavailable> {
  return Effect.promise(() => sharedKeyLoad(url, fetcher, forceRefresh)).pipe(
    Effect.flatMap((keys) =>
      keys === undefined ? Effect.fail(new KeyServiceUnavailable()) : Effect.succeed(keys),
    ),
  );
}
