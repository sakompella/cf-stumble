/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Goal criterion 2's local half: the tenant comes from the verified token and from nowhere else.
 *
 * `access-owner.test.ts` holds the owner allowlist to its contract. These tests hold the boundary
 * to the other half of the same rule — that nothing a request carries can select a tenant — and
 * check the order it happens in: every refusal here lands before `SUPERVISOR.getByName`, which is
 * the call that names a Durable Object and is the first step towards a workspace or a capability.
 */

import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { authenticateAccessRequest, type AccessWorkerEnvironment } from "../../src/access/index.js";
import worker from "../../src/worker.js";
import {
  accessAudience as audience,
  accessIssuer as issuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "../access-tokens.js";

function tokenFor(key: SigningKey, subject: string): Promise<string> {
  return signAccessToken(key, {
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: subject,
  });
}

function accessEnvironment(key: SigningKey): AccessWorkerEnvironment {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };
}

function workerEnvironment(key: SigningKey) {
  return {
    // oxlint-disable-next-line typescript/no-deprecated -- The Worker test environment is supplied by the Cloudflare Vitest plugin.
    ...env,
    ...accessEnvironment(key),
  };
}

/** Watches the one call that names a tenant's Durable Object, so a refusal's timing is visible. */
function supervisorNaming() {
  // oxlint-disable-next-line typescript/no-deprecated -- See above.
  return vi.spyOn(env.SUPERVISOR, "getByName");
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("refuses an unauthenticated request before any tenant is named", async () => {
  const key = await signingKey("scope-unauthenticated-key");
  const naming = supervisorNaming();

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/status"),
    workerEnvironment(key),
  );

  expect(response.status).toBe(401);
  expect(naming, "no credential, so nothing may be named").not.toHaveBeenCalled();
});

test("refuses a valid token for another identity before any tenant is named", async () => {
  const key = await signingKey("scope-wrong-identity-key");
  const naming = supervisorNaming();
  const token = await tokenFor(key, "some-other-verified-user");

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/status", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(401);
  expect(naming, "a verified non-owner names no Durable Object").not.toHaveBeenCalled();
});

test.each([
  "https://cf-stumble.test/api/status?tenant=someone-else",
  "https://cf-stumble.test/api/status?identity=someone-else",
  "https://cf-stumble.test/api/status?audience=another-audience",
  "https://cf-stumble.test/api/status?workspace=tenant:someone-else",
  "https://cf-stumble.test/api/status?supervisor=someone-else",
])("refuses the owner's own token when the request selects a tenant with %s", async (url) => {
  const key = await signingKey("scope-query-key");
  const naming = supervisorNaming();
  const token = await tokenFor(key, accessOwnerSubject);

  const response = await worker.fetch(
    new Request(url, { headers: { "cf-access-jwt-assertion": token } }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(400);
  expect(
    naming,
    "a request that names a tenant is refused, not served and ignored",
  ).not.toHaveBeenCalled();
});

test("refuses a caller-supplied tenant header carried beside a valid owner token", async () => {
  const key = await signingKey("scope-header-key");
  const naming = supervisorNaming();
  const token = await tokenFor(key, accessOwnerSubject);

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/status", {
      headers: {
        "cf-access-jwt-assertion": token,
        "x-cf-stumble-tenant": "someone-else",
      },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(400);
  expect(naming).not.toHaveBeenCalled();
});

test("hands the verified scope on, so nothing downstream derives a tenant of its own", async () => {
  const key = await signingKey("scope-verified-key");
  const token = await tokenFor(key, accessOwnerSubject);

  const result = await authenticateAccessRequest(
    new Request("https://cf-stumble.test/", { headers: { "cf-access-jwt-assertion": token } }),
    accessEnvironment(key),
  );

  if (!result.ok) {
    throw new Error(`the configured owner must be admitted: ${result.reason}`);
  }
  expect(result.scope, "the audience is the configured one, never a request field").toEqual({
    identity: accessOwnerSubject,
    audience,
  });
});
