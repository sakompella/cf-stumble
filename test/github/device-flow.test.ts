import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import {
  redeemDeviceAuthorization,
  requestDeviceAuthorization,
  type GitHubFetch,
} from "../../src/github/index.js";

const CLIENT_ID = "Iv1.cfstumbleFAKE";

function startAuthorization(clientId: string, fetcher: GitHubFetch) {
  return Effect.runPromise(
    requestDeviceAuthorization(clientId, fetcher).pipe(
      Effect.match({
        onSuccess: (authorization) => ({ ok: true, authorization }),
        onFailure: ({ problem }) => ({ ok: false, problem }),
      }),
    ),
  );
}

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

type Call = Readonly<{ url: string; body: string }>;

type DeviceReply = Readonly<{ [field: string]: string | number }> | "error";

function isText(body: RequestInit["body"]): body is string {
  return typeof body === "string";
}

function bodyText(body: RequestInit["body"]): string {
  return isText(body) ? body : "";
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

  const started = await startAuthorization(CLIENT_ID, fetcher);

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
  expect(new URLSearchParams(calls[0]?.body).get("client_id")).toBe(CLIENT_ID);
});

test("refuses to start without a configured client id, and never calls the provider", async () => {
  const { fetcher, calls } = provider([]);

  await expect(startAuthorization("  ", fetcher)).resolves.toEqual({
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

  await expect(startAuthorization(CLIENT_ID, fetcher)).resolves.toEqual({
    ok: false,
    problem,
  });
});

test("redeems one device code and returns the token to its caller only", async () => {
  const { fetcher, calls } = provider([{ access_token: FAKE_TOKEN, token_type: "bearer" }]);

  const redeemed = await Effect.runPromise(
    redeemDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: "device-code-secret" }, fetcher),
  );

  expect(redeemed).toEqual({ kind: "authorized", token: FAKE_TOKEN });
  expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
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
])("maps the redemption reply %j to %j", async (reply, expected) => {
  const { fetcher } = provider([reply]);

  await expect(
    Effect.runPromise(
      redeemDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: "device-code-secret" }, fetcher),
    ),
  ).resolves.toEqual(expected);
});

test("treats an unreachable provider as unavailable rather than as an authorization", async () => {
  const { fetcher } = provider(["error"]);

  await expect(
    Effect.runPromise(
      redeemDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: "device-code-secret" }, fetcher),
    ),
  ).resolves.toEqual({ kind: "unavailable" });
});

test("refuses a device reply whose verification page is not GitHub over HTTPS", async () => {
  const { fetcher } = provider([
    {
      device_code: "device-code-secret",
      user_code: "WDJB-MJHT",
      verification_uri: "http://github.com/login/device",
    },
  ]);

  await expect(startAuthorization(CLIENT_ID, fetcher)).resolves.toEqual({
    ok: false,
    problem: "provider-refused",
  });
});
