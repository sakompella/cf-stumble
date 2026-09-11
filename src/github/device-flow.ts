// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- GitHub's device-flow responses are parsed at this boundary.

/**
 * GitHub's OAuth device flow, as the two calls cf-stumble makes and the values it may keep.
 *
 * ADR-0039 separates repository authorization from Cloudflare Access: signing in proves who the
 * owner is, and this flow is what grants the workspace repository access. Q2 chose the device
 * flow, so the only thing a browser ever sees is a verification URL and a short user code, and the
 * access token exists in one place — the reply to the redemption call below, which the caller
 * installs into the workspace's `gh` configuration and then drops.
 *
 * Everything here is one HTTP call plus parsing, with `fetch` supplied by the caller. No value in
 * this module is stored, logged, or returned to a browser by anything in it.
 */

declare const gitHubTokenBrand: unique symbol;

/** An access token, branded so it cannot be assigned into an ordinary string field by accident. */
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

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * `repo` is what a coding agent needs to clone, push, and open a pull request in a private
 * repository. Nothing here asks for organization administration or user data scopes.
 */
export const GITHUB_DEVICE_SCOPE = "repo";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** The `fetch` this flow uses. Injected so a test drives the provider without a network. */
export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * What GitHub answered the first call with. `deviceCode` is a secret: it is the value that
 * redeems the authorization, so it stays server-side and never reaches a browser or a log. The
 * other three fields are exactly what the owner needs to see.
 */
export type DeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}>;

/**
 * Why no authorization started. `not-configured` means this deployment has no GitHub OAuth client
 * id, which is the owner's setup step rather than a caller's mistake.
 */
export type DeviceFlowProblem = "not-configured" | "provider-unavailable" | "provider-refused";

export type DeviceAuthorizationStart =
  | Readonly<{ ok: true; authorization: DeviceAuthorization }>
  | Readonly<{ ok: false; problem: DeviceFlowProblem }>;

/**
 * The result of one redemption attempt. `pending` and `slow-down` are the ordinary states while
 * the owner is still at GitHub's verification page; the rest are terminal.
 */
export type DeviceRedemption =
  | Readonly<{ kind: "authorized"; token: GitHubToken }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "slow-down"; intervalSeconds: number }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Parse the device-code reply. A reply missing either code is unusable, not partially usable. */
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

/** Parse the redemption reply. An unrecognized error code is `unavailable`, never `authorized`. */
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

/** One JSON object as GitHub returned it. The two parsers above turn it into a domain value. */
export type GitHubDeviceReply = Readonly<Record<string, unknown>>;

async function postForm(
  url: string,
  body: Record<string, string>,
  fetcher: GitHubFetch,
): Promise<GitHubDeviceReply | undefined> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    throw new Error("the GitHub device endpoint refused the request");
  }

  const payload: unknown = await response.json();

  return isRecord(payload) ? payload : undefined;
}

/**
 * Ask GitHub to start one device authorization. The reply is the only place a device code exists,
 * so the caller stores it beside the owner it belongs to rather than returning it anywhere.
 */
export async function requestDeviceAuthorization(
  clientId: string,
  fetcher: GitHubFetch,
): Promise<DeviceAuthorizationStart> {
  if (clientId.trim().length === 0) {
    return { ok: false, problem: "not-configured" };
  }

  let payload: GitHubDeviceReply | undefined;

  try {
    payload = await postForm(
      GITHUB_DEVICE_CODE_URL,
      { client_id: clientId, scope: GITHUB_DEVICE_SCOPE },
      fetcher,
    );
  } catch {
    return { ok: false, problem: "provider-unavailable" };
  }

  const authorization = parseDeviceAuthorization(payload);

  return authorization === undefined
    ? { ok: false, problem: "provider-refused" }
    : { ok: true, authorization };
}

/**
 * Redeem one device code. This is the single call that can yield a token, and it yields it to its
 * caller only: nothing here writes it down.
 */
export async function redeemDeviceAuthorization(
  input: Readonly<{ clientId: string; deviceCode: string }>,
  fetcher: GitHubFetch,
): Promise<DeviceRedemption> {
  try {
    return parseDeviceRedemption(
      await postForm(
        GITHUB_ACCESS_TOKEN_URL,
        {
          client_id: input.clientId,
          device_code: input.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        },
        fetcher,
      ),
    );
  } catch {
    return { kind: "unavailable" };
  }
}
