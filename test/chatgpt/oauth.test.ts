import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { parseRefreshGrant, parseTokenGrant, requestTokens } from "../../src/chatgpt/oauth.js";
import { capturedEvents, named } from "../log-capture.js";
import { ACCESS_ONE, recordingFetch, REFRESH_ONE } from "./fixtures.js";

test("a token request that fails after it was sent is ambiguous, and the request never follows a redirect", async () => {
  const { fetcher, calls } = recordingFetch(() =>
    Promise.reject(new Error("socket closed after send")),
  );

  const outcome = await Effect.runPromise(
    Effect.result(requestTokens(fetcher, {}, parseTokenGrant)),
  );

  expect(Result.isFailure(outcome) ? outcome.failure.failure : "granted").toBe("ambiguous");
  expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/oauth/token");
  expect(calls[0]?.init.redirect).toBe("manual");
});

test("a refused token request logs its status and only the error fields of its JSON body", async () => {
  const logged = capturedEvents();

  const { fetcher } = recordingFetch(() =>
    Promise.resolve(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "code already redeemed",
          code: "code-FAKE",
        },
        { status: 400 },
      ),
    ),
  );

  await Effect.runPromise(Effect.result(requestTokens(fetcher, {}, parseTokenGrant)));

  const [event] = named(logged(), "chatgpt.token-request");
  const { ts: _ts, ...entry } = event ?? {};

  expect(entry).toEqual({
    event: "chatgpt.token-request",
    level: "error",
    status: 400,
    error: "invalid_grant",
    error_description: "code already redeemed",
  });
});

test("a failed token request whose body is not JSON logs only its status", async () => {
  const logged = capturedEvents();

  const { fetcher } = recordingFetch(() =>
    Promise.resolve(new Response("Bad Request", { status: 503 })),
  );

  await Effect.runPromise(Effect.result(requestTokens(fetcher, {}, parseTokenGrant)));

  const [event] = named(logged(), "chatgpt.token-request");
  const { ts: _ts, ...entry } = event ?? {};

  expect(entry).toEqual({
    event: "chatgpt.token-request",
    level: "warn",
    status: 503,
  });
});

test("a sign-in reply without a scope does not connect", () => {
  const reply = { access_token: ACCESS_ONE, refresh_token: REFRESH_ONE, expires_in: 3600 };

  expect(parseTokenGrant(JSON.stringify(reply))).toEqual(Result.fail("ambiguous"));
});

function jwtPart(claims: Readonly<Record<string, string | number>>): string {
  return btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

test("a refresh reply with no lifetime and no readable expiry in its access token is ambiguous", () => {
  const header = jwtPart({ alg: "RS256" });

  const accessTokens = [
    ACCESS_ONE,
    `${header}.${jwtPart({ iat: 1 })}.FAKE`,
    `${header}.${jwtPart({ exp: "4600" })}.FAKE`,
    `${header}.${jwtPart({ exp: 4600 })}`,
    `${header}.not-json-FAKE.FAKE`,
  ];

  for (const accessToken of accessTokens) {
    const reply = JSON.stringify({ access_token: accessToken, refresh_token: REFRESH_ONE });

    expect(parseRefreshGrant(reply, { refreshToken: "previous" }, 0), accessToken).toEqual(
      Result.fail("ambiguous"),
    );
  }
});
