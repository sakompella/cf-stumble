/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { authenticateAccessRequest } from "../src/access/index.js";

import {
  accessAudience as audience,
  accessIssuer as issuer,
  accessNow as now,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";

function token(key: SigningKey, identity: string, tokenIssuer: string = issuer): Promise<string> {
  return signAccessToken(key, {
    iss: tokenIssuer,
    aud: audience,
    exp: now + 60,
    sub: identity,
  });
}

function request(tokenValue: string): Request {
  return new Request("https://cf-stumble.test/", {
    headers: { "cf-access-jwt-assertion": tokenValue },
  });
}

test("loads keys from the team certs URL and uses the cache", async () => {
  const key = await signingKey("cache-key");
  const signed = await token(key, accessOwnerSubject);
  let fetches = 0;

  const fetcher: typeof fetch = (url) => {
    fetches += 1;
    expect(url).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");

    return Promise.resolve(new Response(JSON.stringify({ keys: [key.publicJwk] })));
  };

  const env = {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  await expect(
    authenticateAccessRequest(request(signed), env, now, crypto, fetcher),
  ).resolves.toMatchObject({
    ok: true,
  });
  await expect(
    authenticateAccessRequest(request(signed), env, now, crypto, fetcher),
  ).resolves.toMatchObject({
    ok: true,
  });
  expect(fetches).toBe(1);
});

test("refreshes keys once when rotation introduces an unknown kid", async () => {
  const oldKey = await signingKey("old-key");
  const newKey = await signingKey("new-key");
  const oldToken = await token(oldKey, accessOwnerSubject);
  const newToken = await token(newKey, accessOwnerSubject);
  let fetches = 0;

  const fetcher: typeof fetch = () => {
    fetches += 1;
    const key = fetches === 1 ? oldKey.publicJwk : newKey.publicJwk;

    return Promise.resolve(new Response(JSON.stringify({ keys: [key] })));
  };

  const env = {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  await expect(
    authenticateAccessRequest(request(oldToken), env, now, crypto, fetcher),
  ).resolves.toMatchObject({
    ok: true,
  });
  await expect(
    authenticateAccessRequest(request(newToken), env, now, crypto, fetcher),
  ).resolves.toMatchObject({
    ok: true,
  });
  expect(fetches).toBe(2);
});

test("rejects when fetching the JWKS fails without exposing token material", async () => {
  const key = await signingKey("failure-key");
  const signed = await token(key, "failure-user");
  const fetcher: typeof fetch = () => Promise.reject(new Error(`JWKS unavailable for ${signed}`));

  const result = await authenticateAccessRequest(
    request(signed),
    {
      CF_ACCESS_TEAM_DOMAIN: "failed.cloudflareaccess.com",
      CF_ACCESS_AUD: audience,
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
    now,
    crypto,
    fetcher,
  );

  expect(result).toEqual({ ok: false, reason: "invalid-signature" });
  expect(JSON.stringify(result)).not.toContain(signed);
});

test("rejects malformed JWKS without exposing token material", async () => {
  const key = await signingKey("malformed-key");
  const signed = await token(key, "malformed-user");

  const fetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [{ kty: "RSA" }], tokenLength: signed.length })),
    );

  const result = await authenticateAccessRequest(
    request(signed),
    {
      CF_ACCESS_TEAM_DOMAIN: "malformed.cloudflareaccess.com",
      CF_ACCESS_AUD: audience,
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
    now,
    crypto,
    fetcher,
  );

  expect(result).toEqual({ ok: false, reason: "invalid-signature" });
  expect(JSON.stringify(result)).not.toContain(signed);
});

test("does not refetch keys for repeated unknown key ids", async () => {
  const key = await signingKey("cooldown-known");
  const unknown = await signingKey("cooldown-unknown");
  const unknownToken = await token(unknown, "attacker");
  let fetches = 0;

  const fetcher: typeof fetch = () => {
    fetches += 1;

    return Promise.resolve(new Response(JSON.stringify({ keys: [key.publicJwk] })));
  };

  const env = {
    CF_ACCESS_TEAM_DOMAIN: "cooldown.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(
      authenticateAccessRequest(request(unknownToken), env, now, crypto, fetcher),
    ).resolves.toStrictEqual({ ok: false, reason: "invalid-signature" });
  }

  expect(fetches).toBeLessThanOrEqual(2);
});

test("shares one key fetch across concurrent cold requests", async () => {
  const key = await signingKey("concurrent-key");
  const signed = await token(key, accessOwnerSubject, "https://concurrent.cloudflareaccess.com");
  let fetches = 0;

  const fetcher: typeof fetch = () => {
    fetches += 1;

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(new Response(JSON.stringify({ keys: [key.publicJwk] })));
      }, 5);
    });
  };

  const env = {
    CF_ACCESS_TEAM_DOMAIN: "concurrent.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      authenticateAccessRequest(request(signed), env, now, crypto, fetcher),
    ),
  );

  expect(results.every((result) => result.ok)).toBe(true);
  expect(fetches).toBe(1);
});
