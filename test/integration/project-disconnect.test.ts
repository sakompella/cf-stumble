/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { PROJECT_TURN_LEASE_MS } from "../../src/turn-budget.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { ownerSession, stubExternalBoundaries } from "./owner-session.js";
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

const REMOVAL = "rm -rf --";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function removals(workspace: FakeTenantWorkspace): readonly string[] {
  return workspace.commands.filter((command) => command.includes(REMOVAL));
}

test("a disconnect refused for a live turn leaves the clone, and removes it once the turn ends", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const workspace = stubExternalBoundaries(new FakeTenantWorkspace());
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
