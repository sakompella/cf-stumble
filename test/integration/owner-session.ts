import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { deriveSupervisorName } from "../../src/access/index.js";
import worker from "../../src/worker.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
} from "../access-tokens.js";
import type { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";

/**
 * The owner as the Worker sees them: a signed Access token, the page's own origin, and the
 * Supervisor that the Worker derives from that token. Integration tests send every request through
 * `worker.fetch`, so Access verification and routing run as in a deployment.
 */

const ORIGIN = "https://cf-stumble.test";

export async function ownerSession(keyName: string) {
  const key = await signingKey(keyName);

  const token = await signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });

  const environment = {
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };

  const headers = { "cf-access-jwt-assertion": token, origin: ORIGIN };

  const get = (path: string) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), environment);

  const post = (path: string, body: Readonly<Record<string, string>> = {}) =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      environment,
    );

  const supervisorName = await deriveSupervisorName({
    identity: accessOwnerSubject,
    audience: accessAudience,
  });

  return { get, post, supervisor: env.SUPERVISOR.getByName(supervisorName) };
}

/**
 * Route the Supervisor's `WORKSPACE_HOST` lookups to the fake, and GitHub's REST API nowhere. The
 * test's `afterEach` must call `vi.restoreAllMocks()`.
 */
export function stubExternalBoundaries<Workspace extends FakeTenantWorkspace>(
  workspace: Workspace,
): Workspace {
  // SAFETY: the fake implements every Workspace Host RPC that the test drives.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const host = workspace as unknown as ReturnType<typeof env.WORKSPACE_HOST.getByName>;
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(host);
  // No size metadata, so the size guard fails open, as it does when GitHub cannot be reached.
  // A fresh Response per call, because a body can be read only once.
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response("{}", { status: 404 })),
  );

  return workspace;
}
