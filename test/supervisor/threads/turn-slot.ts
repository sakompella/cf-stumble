/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test";
import { ProjectThreads } from "../../../src/supervisor/threads/index.js";
import { sampleCatalog } from "../../project-fixtures.js";
import type {
  ProjectThreadResult,
  ProjectTurnLeaseResult,
} from "../../../src/supervisor/threads/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

/**
 * The turn slot, driven inside the Durable Object that owns it.
 *
 * Admitting, finishing, and abandoning a turn are not RPC methods any more: the Supervisor runs a
 * whole turn itself (`runProjectTurn`), and a client that could hold a lease could finish a turn
 * it never ran. The lease rules still have to be tested at the level that enforces them, so these
 * helpers run `ProjectThreads` against the storage of the object under test — the same rows
 * `getProjectThread` and a real turn read — rather than through a surface that no longer exists.
 */
function threadsOf(state: DurableObjectState): ProjectThreads {
  return new ProjectThreads(state.storage, () => sampleCatalog);
}

export function startProjectTurn(
  control: DurableObjectStub<Supervisor>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: a project id arrives from a client with no proven shape.
  projectId: unknown,
  expectedRevision: number,
  now: number,
  leaseMs: number,
): Promise<ProjectTurnLeaseResult> {
  return runInDurableObject(control, (_instance, state) =>
    threadsOf(state).startTurn(projectId, expectedRevision, now, leaseMs),
  );
}

export function finishProjectTurn(
  control: DurableObjectStub<Supervisor>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: see `startProjectTurn`.
  projectId: unknown,
  leaseId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: a conversation is proved by the thread's own parser.
  messages: unknown,
  now: number,
): Promise<ProjectThreadResult> {
  return runInDurableObject(control, (_instance, state) =>
    threadsOf(state).finishTurn(projectId, leaseId, messages, now),
  );
}

export function abandonProjectTurn(
  control: DurableObjectStub<Supervisor>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: see `startProjectTurn`.
  projectId: unknown,
  leaseId: string,
): Promise<ProjectThreadResult> {
  return runInDurableObject(control, (_instance, state) =>
    threadsOf(state).abandonTurn(projectId, leaseId),
  );
}

/**
 * Admit a turn and keep the lease it returns, which is the only key its completion accepts. A
 * test that cannot be admitted has no turn to make assertions about, so this throws rather than
 * handing back a lease-shaped nothing.
 */
export async function admitProjectTurn(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
  expectedRevision: number,
  now: number,
  leaseMs: number,
): Promise<string> {
  const started = await startProjectTurn(control, projectId, expectedRevision, now, leaseMs);
  if (!started.ok) {
    throw new Error(`the ${projectId} turn must be admitted: ${started.problem.code}`);
  }
  return started.leaseId;
}
