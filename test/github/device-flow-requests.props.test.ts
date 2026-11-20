import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import {
  redeemDeviceAuthorization,
  requestDeviceAuthorization,
  type GitHubFetch,
} from "../../src/github/index.js";
import { clientIdOf } from "./client-id-fixture.js";

function exchange(url: string, init: RequestInit) {
  return { url, method: init.method, headers: init.headers, body: init.body };
}

type Exchange = ReturnType<typeof exchange>;

function recorder(response: () => Response) {
  const calls: Exchange[] = [];

  const fetcher: GitHubFetch = (url, init) => {
    calls.push(exchange(url, init));

    return Promise.resolve(response());
  };

  return { calls, fetcher };
}

async function formOf(call: Exchange | undefined): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(await new Response(call?.body).text()));
}

const decodeAuthorizationForm = Schema.decodeUnknownSync(
  Schema.Struct({ client_id: Schema.String, scope: Schema.String }),
);

const formHeaders = {
  accept: "application/json",
  "content-type": "application/x-www-form-urlencoded",
};

test("a redemption posts the client id and device code, whatever they contain, to the token endpoint", () =>
  hegel.testAsync(async (tc) => {
    const clientId = tc.draw(gs.text({ minSize: 1, maxSize: 30 }));
    tc.assume(clientId.trim().length > 0);
    const deviceCode = tc.draw(gs.text({ maxSize: 30 }));
    const { calls, fetcher } = recorder(() => Response.json({}));

    await Effect.runPromise(
      redeemDeviceAuthorization({ clientId: clientIdOf(clientId), deviceCode }, fetcher),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      headers: formHeaders,
    });
    expect(await formOf(calls[0])).toEqual({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  }));

function startAuthorization(clientId: string, fetcher: GitHubFetch) {
  return Effect.runPromise(
    requestDeviceAuthorization(clientIdOf(clientId), fetcher).pipe(
      Effect.match({
        onSuccess: (authorization) => ({ ok: true, authorization }),
        onFailure: () => ({ ok: false }),
      }),
    ),
  );
}

test("a client id is sent with the scopes gh needs", () =>
  hegel.testAsync(async (tc) => {
    const clientId = tc.draw(gs.text({ minSize: 1, maxSize: 20 }));
    tc.assume(clientId.trim().length > 0);

    const configured = recorder(() => Response.json({}));

    await startAuthorization(clientId, configured.fetcher);

    expect(configured.calls[0]).toMatchObject({
      url: "https://github.com/login/device/code",
      method: "POST",
      headers: formHeaders,
    });
    const form = decodeAuthorizationForm(await formOf(configured.calls[0]));

    expect(form.client_id).toBe(clientId);
    expect(form.scope.split(" ")).toEqual(["repo", "read:org"]);
  }));

type Timing = Readonly<{ sent?: number | string | null; usable?: number }>;

const timing = gs.oneOf<Timing>(
  gs.just({}),
  gs
    .integers({ minValue: 1, maxValue: 3600 })
    .map((seconds) => ({ sent: seconds, usable: seconds })),
  gs.sampledFrom([0, -1, 0.5, "7", null]).map((sent) => ({ sent })),
);

const codeText = gs.text({ minSize: 1, maxSize: 20 });

const page = gs.fromRegex(String.raw`https://github\.com/[a-z]{1,10}`);

test("a device authorization carries the codes and page it was given, with a default expiry", () =>
  hegel.testAsync(async (tc) => {
    const deviceCode = tc.draw(codeText);
    const userCode = tc.draw(codeText);
    const verificationUri = tc.draw(page);
    const expires = tc.draw(timing);

    const { fetcher } = recorder(() =>
      Response.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        expires_in: expires.sent,
      }),
    );

    await expect(startAuthorization("client", fetcher)).resolves.toEqual({
      ok: true,
      authorization: {
        deviceCode,
        userCode,
        verificationUri,
        expiresInSeconds: expires.usable ?? 900,
      },
    });
  }));

const spoiledAuthorization = gs.sampledFrom([
  { user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device" },
  { device_code: "", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device" },
  { device_code: "code", verification_uri: "https://github.com/login/device" },
  { device_code: "code", user_code: "", verification_uri: "https://github.com/login/device" },
  { device_code: "code", user_code: "WDJB-MJHT" },
  { device_code: "code", user_code: "WDJB-MJHT", verification_uri: 5 },
  { device_code: "code", user_code: "WDJB-MJHT", verification_uri: "github.com/login/device" },
]);

const unusableStart = gs.oneOf(
  spoiledAuthorization.map((reply) => ({
    answer: () => Promise.resolve(Response.json(reply)),
  })),
  gs.sampledFrom([[], "text", 7, null, true]).map((body) => ({
    answer: () => Promise.resolve(Response.json(body)),
  })),
  gs.just({ answer: () => Promise.resolve(new Response("{not json")) }),
  gs.just({ answer: () => Promise.reject(new TypeError("network connection lost")) }),
  gs.sampledFrom([400, 404, 500, 502]).map((status) => ({
    answer: () => Promise.resolve(new Response("{}", { status })),
  })),
);

test("a start reply that cannot begin an authorization starts none", () =>
  hegel.testAsync(async (tc) => {
    const { answer } = tc.draw(unusableStart);

    await expect(startAuthorization("client", answer)).resolves.toEqual({ ok: false });
  }));

const verificationPage = gs.record({
  scheme: gs.sampledFrom(["https", "http", ""]),
  userinfo: gs.sampledFrom(["", "owner@", "owner:secret@", ":secret@"]),
  host: gs.sampledFrom([
    "github.com",
    "GitHub.com",
    "api.github.com",
    "github.com.example.com",
    "example.com",
  ]),
  port: gs.sampledFrom(["", ":443", ":8443"]),
  path: gs.fromRegex("(/[a-z]{1,8}){0,3}"),
});

test("only a page on https://github.com with no credentials in its address can start an authorization", () =>
  hegel.testAsync(async (tc) => {
    const { scheme, userinfo, host, port, path } = tc.draw(verificationPage);
    const verificationUri = `${scheme}://${userinfo}${host}${port}${path}`;

    const safe =
      scheme === "https" &&
      userinfo === "" &&
      host.toLowerCase() === "github.com" &&
      (port === "" || port === ":443");

    const { fetcher } = recorder(() =>
      Response.json({
        device_code: "device-code",
        user_code: "WDJB-MJHT",
        verification_uri: verificationUri,
      }),
    );

    const started = await startAuthorization("client", fetcher);

    if (safe) {
      expect(started.ok, verificationUri).toBe(true);

      return;
    }

    expect(started, verificationUri).toEqual({ ok: false });
  }));

test("regression: the unsafe verification pages GitHub documents are all refused", async () => {
  for (const verificationUri of [
    "http://github.com/login/device",
    "https://example.com/login/device",
    "https://github.com.example.com/login/device",
    "https://github.com@evil.example/login/device",
    "https://owner:secret@github.com/login/device",
    "https://github.com:8443/login/device",
  ]) {
    const { fetcher } = recorder(() =>
      Response.json({
        device_code: "device-code",
        user_code: "WDJB-MJHT",
        verification_uri: verificationUri,
      }),
    );

    await expect(startAuthorization("client", fetcher)).resolves.toEqual({ ok: false });
  }
});
