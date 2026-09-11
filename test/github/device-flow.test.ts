import { expect, test } from "vitest";
import {
  parseDeviceAuthorization,
  parseDeviceRedemption,
  parseGitHubToken,
  redeemDeviceAuthorization,
  requestDeviceAuthorization,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_DEVICE_SCOPE,
  type GitHubFetch,
} from "../../src/github/index.js";

/**
 * The two calls of GitHub's device flow, driven by a fake provider. What matters here is the
 * mapping from GitHub's replies to states cf-stumble can act on, and that the device code — which
 * is the secret half of this flow — travels only where the flow needs it.
 */

const CLIENT_ID = "Iv1.cfstumbleFAKE";

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

type Call = Readonly<{ url: string; body: string }>;

/** One reply GitHub could send: a JSON object, or a failure the flow has to survive. */
type DeviceReply = Readonly<{ [field: string]: string | number }> | "error";

/** The flow sends a form-encoded string body. Anything else would be a change worth failing on. */
function bodyText(body: RequestInit["body"]): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The fetch init is a platform type, not a domain value.
  return typeof body === "string" ? body : "";
}

function provider(replies: readonly DeviceReply[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetcher: GitHubFetch = (url, init) => {
    calls.push({ url, body: bodyText(init.body) });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;

    if (reply === undefined || reply === "error") {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }

    return Promise.resolve(Response.json(reply));
  };

  return { fetcher, calls };
}

test("asks GitHub for a device code and keeps the codes apart", async () => {
  const { fetcher, calls } = provider([
    {
      device_code: "device-code-secret",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
  ]);

  const started = await requestDeviceAuthorization(CLIENT_ID, fetcher);

  expect(started).toEqual({
    ok: true,
    authorization: {
      deviceCode: "device-code-secret",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    },
  });
  expect(calls[0]?.url).toBe(GITHUB_DEVICE_CODE_URL);
  expect(calls[0]?.body).toBe(
    `client_id=${CLIENT_ID}&scope=${encodeURIComponent(GITHUB_DEVICE_SCOPE)}`,
  );
});

test("refuses to start without a configured client id, and never calls the provider", async () => {
  const { fetcher, calls } = provider([]);

  await expect(requestDeviceAuthorization("  ", fetcher)).resolves.toEqual({
    ok: false,
    problem: "not-configured",
  });
  expect(calls).toEqual([]);
});

test.each([
  ["a provider that fails", "error" as const, "provider-unavailable"],
  ["a reply with no device code", { user_code: "WDJB-MJHT" }, "provider-refused"],
])("reports %s rather than starting", async (_name, reply, problem) => {
  const { fetcher } = provider([reply]);

  await expect(requestDeviceAuthorization(CLIENT_ID, fetcher)).resolves.toEqual({
    ok: false,
    problem,
  });
});

test("redeems one device code and returns the token to its caller only", async () => {
  const { fetcher, calls } = provider([{ access_token: FAKE_TOKEN, token_type: "bearer" }]);

  const redeemed = await redeemDeviceAuthorization(
    { clientId: CLIENT_ID, deviceCode: "device-code-secret" },
    fetcher,
  );

  expect(redeemed).toEqual({ kind: "authorized", token: FAKE_TOKEN });
  expect(calls[0]?.url).toBe(GITHUB_ACCESS_TOKEN_URL);
  expect(calls[0]?.body).toContain("device_code=device-code-secret");
});

test.each([
  [{ error: "authorization_pending" }, { kind: "pending" }],
  [
    { error: "slow_down", interval: 10 },
    { kind: "slow-down", intervalSeconds: 10 },
  ],
  [{ error: "expired_token" }, { kind: "expired" }],
  [{ error: "access_denied" }, { kind: "denied" }],
  [{ error: "something_new" }, { kind: "unavailable" }],
  [{}, { kind: "unavailable" }],
])("maps the redemption reply %j to %j", (reply, expected) => {
  expect(parseDeviceRedemption(reply)).toEqual(expected);
});

test("treats an unreachable provider as unavailable rather than as an authorization", async () => {
  const { fetcher } = provider(["error"]);

  await expect(
    redeemDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: "device-code-secret" }, fetcher),
  ).resolves.toEqual({ kind: "unavailable" });
});

test("refuses a device reply whose verification page is not GitHub over HTTPS", () => {
  expect(
    parseDeviceAuthorization({
      device_code: "device-code-secret",
      user_code: "WDJB-MJHT",
      verification_uri: "http://github.com/login/device",
    }),
  ).toBeUndefined();
});

test("refuses a token that is not one line of printable text", () => {
  expect(parseGitHubToken("")).toBeUndefined();
  expect(parseGitHubToken("has space")).toBeUndefined();
  expect(parseGitHubToken(`${FAKE_TOKEN}\n`)).toBeUndefined();
  expect(parseGitHubToken(7)).toBeUndefined();
  expect(parseGitHubToken(FAKE_TOKEN)).toBe(FAKE_TOKEN);
});
