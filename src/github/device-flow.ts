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
  intervalSeconds: number;
}>;

type DeviceFlowProblem = "not-configured" | "provider-unavailable" | "provider-refused";

export class DeviceAuthorizationNotStarted extends Data.TaggedError(
  "DeviceAuthorizationNotStarted",
)<{ readonly problem: DeviceFlowProblem }> {}

export type DeviceRedemption =
  | Readonly<{ kind: "authorized"; token: GitHubToken }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "slow-down"; intervalSeconds: number }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>;

const PositiveSeconds = Schema.Int.check(Schema.isGreaterThan(0));

const DeviceAuthorizationReply = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.String.check(Schema.isStartingWith("https://")),
  expires_in: lenient(PositiveSeconds),
  interval: lenient(PositiveSeconds),
});

const DeviceRedemptionReply = Schema.Struct({
  access_token: lenient(Schema.String),
  error: lenient(Schema.String),
  interval: lenient(PositiveSeconds),
});

function authorizationOf(reply: typeof DeviceAuthorizationReply.Type): DeviceAuthorization {
  return {
    deviceCode: reply.device_code,
    userCode: reply.user_code,
    verificationUri: reply.verification_uri,
    expiresInSeconds: reply.expires_in ?? 900,
    intervalSeconds: reply.interval ?? 5,
  };
}

function redemptionOf(reply: typeof DeviceRedemptionReply.Type): DeviceRedemption {
  const token = reply.access_token === undefined ? undefined : parseGitHubToken(reply.access_token);

  if (token !== undefined) {
    return { kind: "authorized", token };
  }

  switch (reply.error ?? "") {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow-down", intervalSeconds: reply.interval ?? 10 };
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
    DeviceAuthorizationReply,
  ).pipe(
    Effect.catchTag("DeviceEndpointUnavailable", () =>
      Effect.fail(new DeviceAuthorizationNotStarted({ problem: "provider-unavailable" })),
    ),
    Effect.flatMap((reply) =>
      reply === undefined
        ? Effect.fail(new DeviceAuthorizationNotStarted({ problem: "provider-refused" }))
        : Effect.succeed(authorizationOf(reply)),
    ),
  );
}

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
