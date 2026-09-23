/// <reference types="@cloudflare/vitest-plugin/types" />

import { env as workerTestEnv } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateAccessRequest } from "../src/access/index.js";
import worker from "../src/worker.js";

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

/** A JWKS endpoint that answers, but refuses: no thrown cause, just an unusable status. */
const nonOkJwksFetcher: typeof fetch = () => Promise.resolve(new Response("nope", { status: 503 }));

/** A JWKS endpoint that answers 200 with a body that is not JSON at all. */
const nonJsonJwksFetcher: typeof fetch = () => Promise.resolve(new Response("not json"));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

test("reports a key-service failure when fetching the JWKS rejects, without exposing token material", async () => {
  const key = await signingKey("failure-key");
  const signed = await token(key, "failure-user");
  const fetcher: typeof fetch = () => Promise.reject(new Error(`JWKS unavailable for ${signed}`));
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

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

  expect(result).toEqual({ ok: false, reason: "key-service-unavailable" });
  expect(JSON.stringify(result)).not.toContain(signed);
  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("key-service-unavailable");
  expect(logged).not.toContain(signed);
});

test("reports a key-service failure when the JWKS endpoint answers a non-2xx status", async () => {
  const key = await signingKey("status-key");
  const signed = await token(key, "status-user");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await authenticateAccessRequest(
    request(signed),
    {
      CF_ACCESS_TEAM_DOMAIN: "statuscode.cloudflareaccess.com",
      CF_ACCESS_AUD: audience,
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
    now,
    crypto,
    nonOkJwksFetcher,
  );

  expect(result).toEqual({ ok: false, reason: "key-service-unavailable" });
  expect(loggedErrors).toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("503");
});

test("reports a key-service failure when the JWKS response body is not JSON", async () => {
  const key = await signingKey("malformed-json-key");
  const signed = await token(key, "malformed-json-user");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await authenticateAccessRequest(
    request(signed),
    {
      CF_ACCESS_TEAM_DOMAIN: "malformedjson.cloudflareaccess.com",
      CF_ACCESS_AUD: audience,
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
    now,
    crypto,
    nonJsonJwksFetcher,
  );

  expect(result).toEqual({ ok: false, reason: "key-service-unavailable" });
  expect(loggedErrors).toHaveBeenCalledTimes(1);
});

test("reports a key-service failure for malformed JWKS shapes, without exposing token material", async () => {
  const key = await signingKey("malformed-key");
  const signed = await token(key, "malformed-user");

  const fetcher: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: [{ kty: "RSA" }], tokenLength: signed.length })),
    );

  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

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

  expect(result).toEqual({ ok: false, reason: "key-service-unavailable" });
  expect(JSON.stringify(result)).not.toContain(signed);
  expect(loggedErrors).toHaveBeenCalledTimes(1);
});

test("the Worker answers 503 for a JWKS key-service failure, not 401", async () => {
  const key = await signingKey("worker-outage-key");
  const signed = await token(key, accessOwnerSubject);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unreachable"));

  const response = await worker.fetch(request(signed), {
    // oxlint-disable-next-line typescript/no-deprecated -- The Worker test environment is supplied by the Cloudflare Vitest plugin.
    ...workerTestEnv,
    CF_ACCESS_TEAM_DOMAIN: "workeroutage.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  });

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Unauthorized");
});

test("reports a key-service failure when a forced refresh fails after an unknown kid", async () => {
  // Advances past any refresh cooldown a prior test in this file left behind: the cooldown gate
  // is module-global, not scoped to a domain (see "does not refetch keys for repeated unknown key
  // ids"), so this test's own forced refresh must not be swallowed by someone else's.
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 120_000);

  const knownKey = await signingKey("refresh-outage-known");
  const unknownKey = await signingKey("refresh-outage-unknown");
  const signed = await token(unknownKey, "refresh-outage-user");
  let fetches = 0;

  const fetcher: typeof fetch = () => {
    fetches += 1;

    if (fetches === 1) {
      return Promise.resolve(new Response(JSON.stringify({ keys: [knownKey.publicJwk] })));
    }

    return Promise.reject(new Error("JWKS refresh unavailable"));
  };

  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await authenticateAccessRequest(
    request(signed),
    {
      CF_ACCESS_TEAM_DOMAIN: "refresh-outage.cloudflareaccess.com",
      CF_ACCESS_AUD: audience,
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
    now,
    crypto,
    fetcher,
  );

  expect(result).toEqual({ ok: false, reason: "key-service-unavailable" });
  expect(fetches).toBe(2);
  expect(loggedErrors).toHaveBeenCalledTimes(1);
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
