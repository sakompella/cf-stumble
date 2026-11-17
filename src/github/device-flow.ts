import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { lenient } from "../lenient-schema.js";

declare const gitHubTokenBrand: unique symbol;

export type GitHubToken = string & {
  readonly [gitHubTokenBrand]: "GitHubToken";
};

const TOKEN_PATTERN = /^[\u0021-\u007E]{8,255}$/u;

function isGitHubToken(value: string): value is GitHubToken {
  return TOKEN_PATTERN.test(value);
}

export function parseGitHubToken(value: string | undefined): GitHubToken | undefined {
  return value !== undefined && isGitHubToken(value) ? value : undefined;
}

declare const gitHubClientIdBrand: unique symbol;

export type GitHubClientId = string & {
  readonly [gitHubClientIdBrand]: "GitHubClientId";
};

function isGitHubClientId(value: string): value is GitHubClientId {
  return value.trim().length > 0;
}

export function parseGitHubClientId(value: string | undefined): GitHubClientId | undefined {
  return value !== undefined && isGitHubClientId(value) ? value : undefined;
}

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const GITHUB_DEVICE_SCOPE = "repo read:org";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

type DeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}>;

export class DeviceAuthorizationNotStarted extends Data.TaggedError(
  "DeviceAuthorizationNotStarted",
) {}

export type DeviceRedemption =
  | Readonly<{ kind: "authorized"; token: GitHubToken }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>;

const PositiveSeconds = Schema.Int.check(Schema.isGreaterThan(0));

function isGitHubVerificationUri(value: string): boolean {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);

  return url.origin === "https://github.com" && url.username === "" && url.password === "";
}

const DeviceAuthorizationReply = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.String.check(Schema.makeFilter(isGitHubVerificationUri)),
  expires_in: lenient(PositiveSeconds),
});

const DeviceRedemptionReply = Schema.Struct({
  access_token: lenient(Schema.String),
  error: lenient(Schema.String),
});

function authorizationOf(reply: typeof DeviceAuthorizationReply.Type): DeviceAuthorization {
  return {
    deviceCode: reply.device_code,
    userCode: reply.user_code,
    verificationUri: reply.verification_uri,
    expiresInSeconds: reply.expires_in ?? 900,
  };
}

function redemptionOf(reply: typeof DeviceRedemptionReply.Type): DeviceRedemption {
  const token = reply.access_token === undefined ? undefined : parseGitHubToken(reply.access_token);

  if (token !== undefined) {
    return { kind: "authorized", token };
  }

  switch (reply.error ?? "") {
    case "authorization_pending":
    case "slow_down":
      return { kind: "pending" };
    case "expired_token":
      return { kind: "expired" };
    case "access_denied":
      return { kind: "denied" };
    default:
      return { kind: "unavailable" };
  }
}

class DeviceEndpointUnavailable extends Data.TaggedError("DeviceEndpointUnavailable") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function postForm<S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  body: Record<string, string>,
  fetcher: GitHubFetch,
  reply: S,
): Effect.Effect<S["Type"] | undefined, DeviceEndpointUnavailable> {
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

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new DeviceEndpointUnavailable(),
    });

    const payload = decodeJson(text);

    if (Option.isNone(payload)) return yield* new DeviceEndpointUnavailable();

    return Option.getOrUndefined(Schema.decodeUnknownOption(reply)(payload.value));
  });
}

export function requestDeviceAuthorization(
  clientId: GitHubClientId,
  fetcher: GitHubFetch,
): Effect.Effect<DeviceAuthorization, DeviceAuthorizationNotStarted> {
  return postForm(
    GITHUB_DEVICE_CODE_URL,
    { client_id: clientId, scope: GITHUB_DEVICE_SCOPE },
    fetcher,
    DeviceAuthorizationReply,
  ).pipe(
    Effect.mapError(() => new DeviceAuthorizationNotStarted()),
    Effect.flatMap((reply) =>
      reply === undefined
        ? Effect.fail(new DeviceAuthorizationNotStarted())
        : Effect.succeed(authorizationOf(reply)),
    ),
  );
}

export function redeemDeviceAuthorization(
  input: Readonly<{ clientId: GitHubClientId; deviceCode: string }>,
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
    DeviceRedemptionReply,
  ).pipe(
    Effect.map((reply) =>
      reply === undefined ? { kind: "unavailable" as const } : redemptionOf(reply),
    ),
    Effect.catchTag("DeviceEndpointUnavailable", () =>
      Effect.succeed<DeviceRedemption>({ kind: "unavailable" }),
    ),
  );
}
