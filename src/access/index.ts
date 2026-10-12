// This adapter turns a verified token into the one name the Supervisor is addressed by.
// oxlint-disable anti-slop/no-runtime-typeof
import { presentedAccessToken } from "./credentials.js";
import {
  certsUrl,
  fetchPublicKeys,
  issuerForTeamDomain,
  parseSerializedPublicKeys,
  type AccessFetch,
  type AccessPublicKey,
} from "./keys.js";
import {
  deriveSupervisorName,
  parseAccessToken,
  verifyParsedAccessToken,
  type AccessIdentity,
  type AccessPrincipal,
  type AccessVerificationReason,
  type AccessVerificationResult,
  type VerifyAccessTokenInput,
} from "./verification.js";

export { presentedAccessToken, withoutAccessCredentials } from "./credentials.js";

export { deriveSupervisorName, verifyAccessToken } from "./verification.js";

export type { VerifyAccessTokenInput } from "./verification.js";

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

export type AccessRequestResult =
  | { readonly ok: true; readonly supervisorName: string; readonly scope: VerifiedAccessScope }
  | {
      readonly ok: false;
      readonly reason:
        | AccessVerificationReason
        | "invalid-configuration"
        | "not-owner"
        | "key-service-unavailable";
    };

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

type OwnerIdentityResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | {
      readonly ok: false;
      readonly reason: "missing-identity" | "invalid-configuration" | "not-owner";
    };

/**
 * The owner's own agent acts as the owner: its service token resolves to the owner's identity, so
 * it reaches the owner's Supervisor. Any other service token names nobody, as before the agent
 * token existed. This runs on a verified principal, but strictly before a Supervisor name is ever
 * derived for it, so a non-owner request never causes a Durable Object to be named or created.
 */
function ownerIdentity(
  env: AccessWorkerEnvironment,
  principal: AccessPrincipal,
): OwnerIdentityResult {
  if (principal.kind === "service-token" && !isOwnersAgent(env, principal.clientId)) {
    return { ok: false, reason: "missing-identity" };
  }

  // This Worker has exactly one owner, and there is no safe default identity to fall back to.
  const ownerSubject = configuredSecret(env.CF_ACCESS_OWNER_SUB);

  if (ownerSubject === undefined) {
    return { ok: false, reason: "invalid-configuration" };
  }

  if (principal.kind === "user" && principal.subject !== ownerSubject) {
    return { ok: false, reason: "not-owner" };
  }

  return { ok: true, identity: ownerSubject };
}

type BoundaryVerificationResult =
  | AccessVerificationResult
  | { readonly ok: false; readonly reason: "invalid-configuration" | "key-service-unavailable" };

async function verifyUsingAccessKeys(
  input: Omit<VerifyAccessTokenInput, "publicKeys">,
  explicitKeys: readonly AccessPublicKey[] | undefined,
  url: string | undefined,
  fetcher: AccessFetch,
  webCrypto: Crypto,
): Promise<BoundaryVerificationResult> {
  const parsed = parseAccessToken(input.token);

  if (!parsed.ok) {
    return parsed;
  }

  let publicKeys = explicitKeys;

  if (publicKeys === undefined) {
    if (url === undefined) {
      return { ok: false, reason: "invalid-configuration" };
    }

    const loaded = await fetchPublicKeys(url, fetcher, false);

    if (loaded.isErr()) {
      return { ok: false, reason: "key-service-unavailable" };
    }

    publicKeys = loaded.value;
  }

  let verified = await verifyParsedAccessToken(parsed.token, { ...input, publicKeys }, webCrypto);

  if (
    !verified.ok &&
    explicitKeys === undefined &&
    url !== undefined &&
    verified.reason === "invalid-signature" &&
    !hasMatchingKid(publicKeys, parsed.token.header.kid)
  ) {
    const refreshed = await fetchPublicKeys(url, fetcher, true);

    if (refreshed.isErr()) {
      return { ok: false, reason: "key-service-unavailable" };
    }

    verified = await verifyParsedAccessToken(
      parsed.token,
      { ...input, publicKeys: refreshed.value },
      webCrypto,
    );
  }

  return verified;
}

function hasMatchingKid(publicKeys: readonly AccessPublicKey[], kid: string | undefined): boolean {
  return kid !== undefined && publicKeys.some((key) => key.kid === kid);
}

interface AccessConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly explicitKeys: readonly AccessPublicKey[] | undefined;
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

/** The one admitted result. The Supervisor's name and the scope it was derived from travel together. */
async function admitted(
  scope: VerifiedAccessScope,
  webCrypto: Crypto,
): Promise<AccessRequestResult> {
  return { ok: true, supervisorName: await deriveSupervisorName(scope, webCrypto), scope };
}

/**
 * Turn one request into the verified tenant it may act as, or into the reason it may not.
 *
 * Two kinds of request are refused here, before anything is named: one that presents no usable
 * credential, and one whose verified principal is neither the configured owner nor the owner's
 * agent service token. The owner check runs on a verified principal but strictly before a
 * Supervisor name is derived, so a non-owner never causes a Durable Object, a workspace, or a
 * capability to exist. This Worker has exactly one owner and no default identity to fall back
 * on, so a missing owner subject is a configuration failure rather than an open door.
 */
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

  const owner = ownerIdentity(env, verified.principal);

  if (!owner.ok) {
    return owner;
  }

  return admitted({ identity: owner.identity, audience: configuration.audience }, webCrypto);
}
