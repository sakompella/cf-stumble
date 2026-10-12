// This adapter turns a verified token into the one name the Supervisor is addressed by.
// oxlint-disable anti-slop/no-runtime-typeof
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { presentedAccessToken } from "./credentials.js";
import {
  certsUrl,
  fetchPublicKeys,
  issuerForTeamDomain,
  parseSerializedPublicKeys,
  type AccessFetch,
  type AccessPublicKey,
  type KeyServiceUnavailable,
} from "./keys.js";
import {
  deriveSupervisorName,
  parseAccessToken,
  TokenRejected,
  verifyParsedAccessToken,
  type AccessIdentity,
  type AccessPrincipal,
} from "./verification.js";

export { presentedAccessToken, withoutAccessCredentials } from "./credentials.js";

export { deriveSupervisorName, verifyAccessToken } from "./verification.js";

export type {
  AccessPrincipal,
  AccessVerificationReason,
  TokenRejected,
  VerifyAccessTokenInput,
} from "./verification.js";

export interface AccessWorkerEnvironment {
  readonly CF_ACCESS_TEAM_DOMAIN: string;
  readonly CF_ACCESS_AUD: string;
  readonly CF_ACCESS_PUBLIC_KEYS?: string;
  readonly CF_ACCESS_OWNER_SUB: string;
  /** The Client ID of the owner's agent service token. Unset, no service token is admitted. */
  readonly CF_ACCESS_AGENT_CLIENT_ID?: string;
}

/**
 * The verified tenant, as the boundary proved it. This is the only place identity and audience are
 * settled, and everything downstream is named from them: the Supervisor by its name, and that
 * Supervisor's one Computer workspace by its own tenant key. A consumer that needs to know whose
 * request this is reads this rather than deriving a second opinion from the request.
 */
export type VerifiedAccessScope = Readonly<{
  identity: AccessIdentity;
  audience: string;
}>;

/** The one admitted result. The Supervisor's name and the scope it was derived from travel together. */
export type AdmittedAccess = Readonly<{ supervisorName: string; scope: VerifiedAccessScope }>;

/** This Worker's own Access configuration is missing or unusable. It says nothing about the caller. */
export class InvalidConfiguration extends Data.TaggedError("InvalidConfiguration") {
  get reason(): "invalid-configuration" {
    return "invalid-configuration";
  }
}

/** A verified person who is not this Worker's one owner. */
export class NotOwner extends Data.TaggedError("NotOwner") {
  get reason(): "not-owner" {
    return "not-owner";
  }
}

/** Why a request may not act as anyone. Each refusal carries the stable code it is answered with. */
type AccessRefusal = TokenRejected | InvalidConfiguration | NotOwner | KeyServiceUnavailable;

export type AccessRefusalReason = AccessRefusal["reason"];

// A missing, empty, or whitespace-only secret is the same as an unset one.
function configuredSecret(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function isOwnersAgent(env: AccessWorkerEnvironment, clientId: string): boolean {
  const agentClientId = configuredSecret(env.CF_ACCESS_AGENT_CLIENT_ID);

  return agentClientId !== undefined && clientId === agentClientId;
}

/**
 * The owner's own agent acts as the owner: its service token resolves to the owner's identity, so
 * it reaches the owner's Supervisor. Any other service token names nobody, as before the agent
 * token existed. This runs on a verified principal, but strictly before a Supervisor name is ever
 * derived for it, so a non-owner request never causes a Durable Object to be named or created.
 */
function ownerIdentity(
  env: AccessWorkerEnvironment,
  principal: AccessPrincipal,
): Effect.Effect<AccessIdentity, TokenRejected | InvalidConfiguration | NotOwner> {
  if (principal.kind === "service-token" && !isOwnersAgent(env, principal.clientId)) {
    return Effect.fail(new TokenRejected({ reason: "missing-identity" }));
  }

  // This Worker has exactly one owner, and there is no safe default identity to fall back to.
  const ownerSubject = configuredSecret(env.CF_ACCESS_OWNER_SUB);

  if (ownerSubject === undefined) {
    return Effect.fail(new InvalidConfiguration());
  }

  if (principal.kind === "user" && principal.subject !== ownerSubject) {
    return Effect.fail(new NotOwner());
  }

  return Effect.succeed(ownerSubject);
}

interface AccessConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly explicitKeys: readonly AccessPublicKey[] | undefined;
  readonly certsUrl: string | undefined;
}

function hasMatchingKid(publicKeys: readonly AccessPublicKey[], kid: string | undefined): boolean {
  return kid !== undefined && publicKeys.some((key) => key.kid === kid);
}

/**
 * Verify against the configured keys, or against the fetched key set. A fetched set that has no
 * key for the token's `kid` is refreshed once, because Access may have rotated its keys.
 */
const verifyUsingAccessKeys = Effect.fnUntraced(function* (
  token: string,
  configuration: AccessConfiguration,
  now: number,
  webCrypto: Crypto,
  fetcher: AccessFetch,
) {
  const parsed = yield* parseAccessToken(token);
  const claims = { issuer: configuration.issuer, audience: configuration.audience, now };

  if (configuration.explicitKeys !== undefined) {
    const publicKeys = configuration.explicitKeys;

    return yield* verifyParsedAccessToken(parsed, { ...claims, publicKeys }, webCrypto);
  }

  const url = configuration.certsUrl;

  if (url === undefined) {
    return yield* new InvalidConfiguration();
  }

  const publicKeys = yield* fetchPublicKeys(url, fetcher, false);

  return yield* verifyParsedAccessToken(parsed, { ...claims, publicKeys }, webCrypto).pipe(
    Effect.catchIf(
      (rejection) =>
        rejection.reason === "invalid-signature" && !hasMatchingKid(publicKeys, parsed.header.kid),
      () =>
        fetchPublicKeys(url, fetcher, true).pipe(
          Effect.flatMap((refreshed) =>
            verifyParsedAccessToken(parsed, { ...claims, publicKeys: refreshed }, webCrypto),
          ),
        ),
    ),
  );
});

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

/**
 * Turn one request into the verified tenant it may act as, or fail with the reason it may not.
 *
 * Two kinds of request are refused here, before anything is named: one that presents no usable
 * credential, and one whose verified principal is neither the configured owner nor the owner's
 * agent service token. The owner check runs on a verified principal but strictly before a
 * Supervisor name is derived, so a non-owner never causes a Durable Object, a workspace, or a
 * capability to exist. This Worker has exactly one owner and no default identity to fall back
 * on, so a missing owner subject is a configuration failure rather than an open door.
 */
export const admitAccessRequest = Effect.fnUntraced(function* (
  request: Request,
  env: AccessWorkerEnvironment,
  now: number = Math.floor(Date.now() / 1000),
  webCrypto: Crypto = crypto,
  fetcher: AccessFetch = fetch,
) {
  // An absent credential and an unusable one are the same failure: no verified identity.
  const token = presentedAccessToken(request);

  if (token === undefined) {
    return yield* new TokenRejected({ reason: "malformed-token" });
  }

  const configuration = accessConfiguration(env);

  if (configuration === undefined) {
    return yield* new InvalidConfiguration();
  }

  const principal = yield* verifyUsingAccessKeys(token, configuration, now, webCrypto, fetcher);
  const identity = yield* ownerIdentity(env, principal);
  const scope: VerifiedAccessScope = { identity, audience: configuration.audience };

  const admitted: AdmittedAccess = {
    supervisorName: yield* deriveSupervisorName(scope, webCrypto),
    scope,
  };

  return admitted;
});
