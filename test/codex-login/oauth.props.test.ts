import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { parseCallback, parseTokenGrant } from "../../src/codex-login/oauth.js";

const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

const DYNAMIC_CLIENT_ID = "dynamic_agent_client";

const DIRECT_SCOPE_WORD = "chatgpt.tokens.use.direct";

const callbackValue = gs.text({ categories: ["L", "N", "P", "S"], minSize: 1, maxSize: 40 });

const clientId = callbackValue.filter((id) => id !== DYNAMIC_CLIENT_ID);

const state = gs.fromRegex("[A-Za-z0-9_-]{8,43}");

const extraParameter = gs.tuples(
  gs.text({ alphabet: "abxyz", minSize: 1, maxSize: 5 }).map((name) => `extra_${name}`),
  gs.text({ maxSize: 40 }),
);

const whitespace = gs.text({ alphabet: " \t\n", maxSize: 3 });

const separator = gs.text({ alphabet: " \t\n", minSize: 1, maxSize: 3 });

const scopeWords = gs.sampledFrom([
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  `x${DIRECT_SCOPE_WORD}`,
  `${DIRECT_SCOPE_WORD}x`,
  "chatgpt.tokens.use",
]);

const validToken = gs.fromRegex("[!-~]{1,64}");

const brokenToken = gs.oneOf(
  gs
    .tuples(
      validToken,
      gs.integers({ minValue: 0, maxValue: 64 }),
      gs.sampledFrom([" ", "\t", "\n", "\u007F", "é", "\u0000"]),
    )
    .map(([token, at, character]) => `${token.slice(0, at)}${character}${token.slice(at)}`),
  gs.just(""),
);

const soundLifetime = gs.oneOf(
  gs.integers({ minValue: 1, maxValue: 1e9 }),
  gs.floats({ minValue: 0.001, maxValue: 1e6 }),
);

const unsoundLifetime = gs.oneOf<unknown>(
  gs.just(0),
  gs.integers({ minValue: -1e9, maxValue: -1 }),
  gs.floats({ minValue: -1e6, maxValue: 0 }),
  gs.sampledFrom([Number.NaN, "3600", null, true, undefined]),
);

const faults = ["none", "access token", "refresh token", "lifetime"] as const;

test("a pasted address yields its code and client, whatever they contain and however it is padded", () => {
  hegel.test((tc) => {
    const code = tc.draw(callbackValue);
    const client = tc.draw(clientId);
    const signIn = tc.draw(state);
    const extras = tc.draw(gs.arrays(extraParameter, { maxSize: 3 }));

    const query = new URLSearchParams([
      ["code", code],
      ["state", signIn],
      ["client_id", client],
      ...extras,
    ]).toString();

    const pasted = `${tc.draw(whitespace)}${REDIRECT_URI}?${query}${tc.draw(whitespace)}`;

    expect(parseCallback(pasted, signIn)).toEqual(Result.succeed({ code, clientId: client }));
  });
});

test("any pasted text is answered, never thrown on", () => {
  hegel.test((tc) => {
    const pasted = tc.draw(
      gs.oneOf(
        gs.text(),
        gs.text().map((rest) => `${REDIRECT_URI}?${rest}`),
      ),
    );

    expect(() => parseCallback(pasted, tc.draw(state))).not.toThrow();
  });
});

test("a token reply connects only with sound tokens, a positive lifetime and the direct-use scope as a whole word", () => {
  hegel.test((tc) => {
    const words = tc.draw(gs.arrays(scopeWords, { maxSize: 6 }));
    const withDirect = tc.draw(gs.booleans());
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: words.length }));
    const fault = tc.draw(gs.sampledFrom(faults));
    const accessToken = tc.draw(fault === "access token" ? brokenToken : validToken);
    const refreshToken = tc.draw(fault === "refresh token" ? brokenToken : validToken);
    const expiresIn = tc.draw(fault === "lifetime" ? unsoundLifetime : soundLifetime);

    const listed = withDirect
      ? [...words.slice(0, at), DIRECT_SCOPE_WORD, ...words.slice(at)]
      : words;

    const separators = tc.draw(
      gs.arrays(separator, { minSize: listed.length, maxSize: listed.length }),
    );

    const scope = listed
      .map((word, index) => `${index === 0 ? "" : separators[index]}${word}`)
      .join("");

    const body = JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      scope,
      expires_in: expiresIn,
    });

    if (fault !== "none") {
      expect(parseTokenGrant(body)).toEqual(Result.fail("ambiguous"));
    } else if (withDirect) {
      expect(parseTokenGrant(body)).toEqual(
        Result.succeed({ accessToken, refreshToken, expiresInMs: Number(expiresIn) * 1000 }),
      );
    } else {
      expect(parseTokenGrant(body)).toEqual(Result.fail("missing-scope"));
    }
  });
});

test("text that is not a token reply never connects", () => {
  hegel.test((tc) => {
    expect(parseTokenGrant(tc.draw(gs.text()))).toEqual(Result.fail("ambiguous"));
  });
});
