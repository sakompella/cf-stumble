/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../../src/worker.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { capturedEvents, named } from "../log-capture.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "../access-tokens.js";
import { ownerApiSupervisor, ownerScope } from "./helpers.js";

/**
 * A refusal at the boundary is logged with a reason code, the route pattern it hit, and the
 * method: enough to tell a misconfigured deployment from a stranger's probe, and nothing that
 * came from the request itself. No header value, cookie, token, query string, or project id may
 * reach the log.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function workerEnvironment(key: SigningKey, ownerSubject = accessOwnerSubject) {
  return {
    // oxlint-disable-next-line typescript/no-deprecated
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: ownerSubject,
  };
}

const SECRET_COOKIE = "CF_Authorization=cfstumble-secret-cookie-value";

test("an unusable credential is refused with its reason and route pattern, and no request text", async () => {
  const events = capturedEvents();
  const key = await signingKey("boundary-log-malformed");

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/projects/secret-project/turn?q=secret-query", {
      method: "POST",
      headers: { cookie: SECRET_COOKIE },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(401);
  const refused = named(events(), "access.refused");
  expect(refused).toEqual([
    expect.objectContaining({
      level: "info",
      reason: "malformed-token",
      route: "/api/projects/:projectId/turn",
      method: "POST",
      status: 401,
    }),
  ]);
  const written = JSON.stringify(events());
  expect(written).not.toContain("cfstumble-secret-cookie-value");
  expect(written).not.toContain("secret-query");
  expect(written, "a project id is request data").not.toContain("secret-project");
});

test("a verified identity that is not the owner is refused as not-owner, at warn level", async () => {
  const events = capturedEvents();
  const key = await signingKey("boundary-log-not-owner");

  const token = await signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "someone-else",
  });

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/status", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(401);
  expect(named(events(), "access.refused")).toEqual([
    expect.objectContaining({ level: "warn", reason: "not-owner", route: "/api/status" }),
  ]);
  const written = JSON.stringify(events());
  expect(written, "the token is a credential").not.toContain(token);
  expect(written, "the subject is an identity").not.toContain("someone-else");
});

test("a deployment with no owner configured is refused as its own fault, at error level", async () => {
  const events = capturedEvents();
  const key = await signingKey("boundary-log-configuration");

  const token = await signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/some/generation/path", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    workerEnvironment(key, " "),
  );

  expect(response.status).toBe(500);
  expect(named(events(), "access.refused")).toEqual([
    expect.objectContaining({
      level: "error",
      reason: "invalid-configuration",
      route: "relay",
      status: 500,
    }),
  ]);
});

test("a cross-origin mutation is refused with the route pattern, and never the origin", async () => {
  const events = capturedEvents();

  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/projects/secret-project/thread/fresh", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    ownerApiSupervisor(),
    ownerScope,
  );

  expect(response.status).toBe(403);
  expect(named(events(), "route.cross-origin-refused")).toEqual([
    expect.objectContaining({
      level: "warn",
      route: "/api/projects/:projectId/thread/fresh",
      method: "POST",
      origin: "foreign",
    }),
  ]);
  const written = JSON.stringify(events());
  expect(written).not.toContain("evil.example");
  expect(written).not.toContain("secret-project");
});
