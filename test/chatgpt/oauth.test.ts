import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { parseCallback, parseTokenGrant, requestTokens } from "../../src/chatgpt/oauth.js";
import { ACCESS_ONE, DIRECT_SCOPE, grant, recordingFetch, REFRESH_ONE } from "./fixtures.js";

const STATE = "state-FAKE-0123456789";

function callback(query: string): string {
  return `http://127.0.0.1:1455/auth/callback?${query}`;
}

test("a pasted address yields its code and issued client only when it is this sign-in's", () => {
  expect(parseCallback(callback(`code=c1&state=${STATE}&client_id=oaiapp_1`), STATE)).toEqual(
    Result.succeed({ code: "c1", clientId: "oaiapp_1" }),
  );

  const refusals: ReadonlyArray<readonly [string, string]> = [
    ["https://evil.example/auth/callback?code=c1", "bad-address"],
    ["http://127.0.0.1:1455/callback?code=c1", "bad-address"],
    ["not an address", "bad-address"],
    [callback(`code=c1&code=c2&state=${STATE}&client_id=a`), "bad-address"],
    [callback(`error=access_denied&state=${STATE}`), "provider-refused"],
    [callback("code=c1&state=other&client_id=a"), "wrong-sign-in"],
    [callback(`state=${STATE}&client_id=a`), "missing-code"],
    [callback(`code=c1&state=${STATE}`), "missing-client"],
    [callback(`code=c1&state=${STATE}&client_id=dynamic_agent_client`), "missing-client"],
    [callback(`code=c1&state=${STATE}&client_id=a&pad=${"x".repeat(5000)}`), "bad-address"],
  ];

  for (const [pasted, problem] of refusals) {
    expect(parseCallback(pasted, STATE), pasted.slice(0, 80)).toEqual(Result.fail(problem));
  }
});

test("a token reply without the direct-use scope cannot connect", () => {
  const body = { access_token: ACCESS_ONE, refresh_token: REFRESH_ONE, expires_in: 3600 };

  const reply = (fields: Readonly<Record<string, string>>) =>
    JSON.stringify({ ...body, ...fields });

  expect(parseTokenGrant(reply({ scope: DIRECT_SCOPE }))).toEqual(
    Result.succeed({ accessToken: ACCESS_ONE, refreshToken: REFRESH_ONE, expiresInMs: 3_600_000 }),
  );
  expect(parseTokenGrant(reply({ scope: "openid offline_access" }))).toEqual(
    Result.fail("missing-scope"),
  );
  expect(parseTokenGrant(reply({ access_token: "has space", scope: DIRECT_SCOPE }))).toEqual(
    Result.fail("ambiguous"),
  );
});

test("the token endpoint's status decides whether a failure consumed anything", async () => {
  const cases: ReadonlyArray<readonly [() => Promise<Response>, string]> = [
    [() => Promise.resolve(new Response("busy", { status: 429 })), "rate-limited"],
    [() => Promise.resolve(new Response("down", { status: 503 })), "temporary"],
    [() => Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })), "rejected"],
    [() => Promise.resolve(new Response("not json", { status: 200 })), "ambiguous"],
    [() => Promise.reject(new Error("socket closed after send")), "ambiguous"],
  ];

  for (const [reply, failure] of cases) {
    const { fetcher } = recordingFetch(reply);
    const outcome = await Effect.runPromise(Effect.result(requestTokens(fetcher, {})));
    expect(Result.isFailure(outcome) ? outcome.failure.failure : "granted").toBe(failure);
  }

  const { fetcher, calls } = recordingFetch(() => Promise.resolve(grant(ACCESS_ONE, REFRESH_ONE)));
  await Effect.runPromise(requestTokens(fetcher, { grant_type: "refresh_token" }));
  expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
  expect(calls[0]?.init.redirect).toBe("manual");
});
