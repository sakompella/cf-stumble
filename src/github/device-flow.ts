// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- GitHub's device-flow responses are parsed at this boundary.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isRecord } from "../untrusted.js";

/**
 * The access token exists in one place, the reply to the redemption call, which the caller installs
 * into the workspace's `gh` configuration and then drops. Nothing here stores, logs, or returns a
 * value to a browser.
 */

declare const gitHubTokenBrand: unique symbol;

export type GitHubToken = string & {
  readonly [gitHubTokenBrand]: "GitHubToken";
};

const TOKEN_PATTERN = /^[\u0021-\u007E]{8,255}$/u;

export function parseGitHubToken(value: unknown): GitHubToken | undefined {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: TOKEN_PATTERN accepts exactly one line of non-blank printable ASCII.
  return value as GitHubToken;
}

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** `repo` is what an agent needs to clone, push, and open a pull request in a private repository. */
const GITHUB_DEVICE_SCOPE = "repo";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

/** `deviceCode` is a secret that redeems the authorization; it never reaches a browser or a log. */
type DeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}>;

/** `not-configured` means this deployment has no GitHub OAuth client id. */
type DeviceFlowProblem = "not-configured" | "provider-unavailable" | "provider-refused";

export class DeviceAuthorizationNotStarted extends Data.TaggedError(
  "DeviceAuthorizationNotStarted",
)<{ readonly problem: DeviceFlowProblem }> {}

/** `pending` and `slow-down` are ordinary while the owner is still at GitHub's verification page. */
export type DeviceRedemption =
  | Readonly<{ kind: "authorized"; token: GitHubToken }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "slow-down"; intervalSeconds: number }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>;

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function parseDeviceAuthorization(value: unknown): DeviceAuthorization | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const deviceCode = value.device_code;
  const userCode = value.user_code;
  const verificationUri = value.verification_uri;

  if (
    typeof deviceCode !== "string" ||
    deviceCode.length === 0 ||
    typeof userCode !== "string" ||
    userCode.length === 0 ||
    typeof verificationUri !== "string" ||
    !verificationUri.startsWith("https://")
  ) {
    return undefined;
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresInSeconds: positiveSeconds(value.expires_in, 900),
    intervalSeconds: positiveSeconds(value.interval, 5),
  };
}

/** An unrecognized error code is `unavailable`, never `authorized`. */
export function parseDeviceRedemption(value: unknown): DeviceRedemption {
  if (!isRecord(value)) {
    return { kind: "unavailable" };
  }

  const token = parseGitHubToken(value.access_token);

  if (token !== undefined) {
    return { kind: "authorized", token };
  }

  switch (value.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow-down", intervalSeconds: positiveSeconds(value.interval, 10) };
    case "expired_token":
      return { kind: "expired" };
    case "access_denied":
      return { kind: "denied" };
    default:
      return { kind: "unavailable" };
  }
}

type GitHubDeviceReply = Readonly<Record<string, unknown>>;

class DeviceEndpointUnavailable extends Data.TaggedError("DeviceEndpointUnavailable") {}

function postForm(
  url: string,
  body: Record<string, string>,
  fetcher: GitHubFetch,
): Effect.Effect<GitHubDeviceReply | undefined, DeviceEndpointUnavailable> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(body).toString(),
        }),
      catch: () => new DeviceEndpointUnavailable(),
    });

    if (!response.ok) return yield* new DeviceEndpointUnavailable();

    const payload: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new DeviceEndpointUnavailable(),
    });

    return isRecord(payload) ? payload : undefined;
  });
}

/** The reply is the only place a device code exists, so the caller stores it beside its owner. */
export function requestDeviceAuthorization(
  clientId: string,
  fetcher: GitHubFetch,
): Effect.Effect<DeviceAuthorization, DeviceAuthorizationNotStarted> {
  if (clientId.trim().length === 0) {
    return Effect.fail(new DeviceAuthorizationNotStarted({ problem: "not-configured" }));
  }

  return postForm(
    GITHUB_DEVICE_CODE_URL,
    { client_id: clientId, scope: GITHUB_DEVICE_SCOPE },
    fetcher,
  ).pipe(
    Effect.catchTag("DeviceEndpointUnavailable", () =>
      Effect.fail(new DeviceAuthorizationNotStarted({ problem: "provider-unavailable" })),
    ),
    Effect.flatMap((payload) => {
      const authorization = parseDeviceAuthorization(payload);

      return authorization === undefined
        ? Effect.fail(new DeviceAuthorizationNotStarted({ problem: "provider-refused" }))
        : Effect.succeed(authorization);
    }),
  );
}

/** The single call that can yield a token, and it yields it to its caller only. */
export function redeemDeviceAuthorization(
  input: Readonly<{ clientId: string; deviceCode: string }>,
  fetcher: GitHubFetch,
): Effect.Effect<DeviceRedemption> {
  return postForm(
    GITHUB_ACCESS_TOKEN_URL,
    {
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    },
    fetcher,
  ).pipe(
    Effect.map((reply) => parseDeviceRedemption(reply)),
    Effect.catchTag("DeviceEndpointUnavailable", () =>
      Effect.succeed<DeviceRedemption>({ kind: "unavailable" }),
    ),
  );
}
