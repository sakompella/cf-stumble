/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { deriveSupervisorName } from "../../src/access/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../src/turn-budget.js";
import worker from "../../src/worker.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
} from "../access-tokens.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { abandonProjectTurn, startProjectTurn } from "../supervisor/threads/turn-slot.js";

/**
 * Disconnecting a project through the owner's HTTP route, with every cf-stumble layer real: the
 * Worker's Access check and routing, the Supervisor Durable Object, its thread store and project
 * catalog, and the Workspace Host's request parsing and removal plan. Only Computer's shell (the
 * fake in `fake-tenant-workspace.ts`) and GitHub's REST API are replaced.
 *
 * The lower-level tests each hold one side: `project-lifecycle.test.ts` gives the connections a
 * thread check that refuses, and `threads.test.ts` refuses a disconnect against a Workspace Host
 * that this runtime cannot start. Neither can see whether a refused disconnect still ran `rm`.
 */

const ORIGIN = "https://cf-stumble.test";

const REMOVAL = "rm -rf --";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function ownerSession(keyName: string) {
  const key = await signingKey(keyName);

  const token = await signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });

  const environment = {
    // oxlint-disable-next-line typescript/no-deprecated
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

/** Route the Supervisor's `WORKSPACE_HOST` lookups to the fake, and GitHub's REST API nowhere. */
function stubExternalBoundaries(): FakeTenantWorkspace {
  const workspace = new FakeTenantWorkspace();

  // SAFETY: the fake implements every Workspace Host RPC that connect and disconnect call.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const host = workspace as unknown as ReturnType<typeof env.WORKSPACE_HOST.getByName>;
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(host);
  // No size metadata, so the size guard fails open, as it does when GitHub cannot be reached.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));

  return workspace;
}

function removals(workspace: FakeTenantWorkspace): readonly string[] {
  return workspace.commands.filter((command) => command.includes(REMOVAL));
}

test("a disconnect refused for a live turn leaves the clone, and removes it once the turn ends", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const workspace = stubExternalBoundaries();
  const owner = await ownerSession("integration-disconnect-live-turn");
  const projectPath = `/api/projects/${sampleProjectOne.id}`;

  const connected = await owner.post("/api/projects/connect", {
    repositoryUrl: sampleProjectOne.repositoryUrl,
  });

  expect(connected.status).toBe(200);
  await expect(connected.json()).resolves.toMatchObject({
    ok: true,
    project: { id: sampleProjectOne.id },
  });

  const turn = await startProjectTurn(
    owner.supervisor,
    sampleProjectOne.id,
    0,
    Date.now(),
    PROJECT_TURN_LEASE_MS,
  );

  if (!turn.ok) throw new Error(`the turn must be admitted: ${turn.problem.code}`);

  const refused = await owner.post(`${projectPath}/disconnect`);

  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toMatchObject({
    ok: false,
    problem: { code: "turn-active" },
  });
  expect(removals(workspace), "a live turn's working tree must not be deleted").toEqual([]);

  const listed = await owner.get("/api/projects");
  await expect(listed.json()).resolves.toMatchObject({
    projects: [{ kind: "repository", ...sampleProjectOne }, { id: "harness" }],
  });

  const thread = await owner.get(`${projectPath}/thread`);
  await expect(thread.json()).resolves.toMatchObject({ ok: true, thread: { turnActive: true } });

  await abandonProjectTurn(owner.supervisor, sampleProjectOne.id, turn.leaseId);

  const disconnected = await owner.post(`${projectPath}/disconnect`);

  expect(disconnected.status).toBe(200);
  await expect(disconnected.json()).resolves.toEqual({
    ok: true,
    projectId: sampleProjectOne.id,
    workspace: "removed",
  });
  expect(removals(workspace)).toHaveLength(1);

  const gone = await owner.get(`${projectPath}/thread`);
  expect(gone.status).toBe(404);
});
