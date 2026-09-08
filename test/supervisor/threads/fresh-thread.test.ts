/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { connectedSupervisor as supervisor } from "../helpers.js";
import { FakeWorkspace } from "./fake-workspace.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";
import { abandonProjectTurn, finishProjectTurn, startProjectTurn } from "./turn-slot.js";

const NOW = 1_700_000_000_000;
const LEASE_MS = 30_000;

const savedConversation = [
  THREAD_MESSAGE_SAMPLES.user,
  THREAD_MESSAGE_SAMPLES.assistant,
  THREAD_MESSAGE_SAMPLES.toolResult,
  THREAD_MESSAGE_SAMPLES.compactionSummary,
];

/**
 * A project workspace holding what a turn wrote into it.
 *
 * The workspace is a fake because a Computer container cannot run under `workerd`, but the thing
 * this test holds is not the container: it is that starting a fresh thread reaches nothing but
 * thread storage. A fake records every call, so "the files survived" is checked as "the reset made
 * no workspace call at all" rather than as "no call happened to break anything".
 */
async function workspaceWithTurnOutput(): Promise<FakeWorkspace> {
  const workspace = new FakeWorkspace({ files: { "/workspace/notes.md": "written before" } });
  await workspace.project().writeFile("/workspace/plan.md", "the agent wrote this during a turn");
  return workspace;
}

function sortedFiles(workspace: FakeWorkspace): readonly (readonly [string, string])[] {
  return [...workspace.files.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}

/** Admit a turn and keep the lease it returns, which is the only key its completion accepts. */
async function admit(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
  expectedRevision: number,
): Promise<string> {
  const started = await startProjectTurn(control, projectId, expectedRevision, NOW, LEASE_MS);
  if (!started.ok) {
    throw new Error(`the ${projectId} turn must be admitted: ${started.problem.code}`);
  }
  return started.leaseId;
}

async function threadWithConversation(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<void> {
  const lease = await admit(control, projectId, 0);
  const finished = await finishProjectTurn(control, projectId, lease, savedConversation, NOW);
  if (!finished.ok) {
    throw new Error(`the ${projectId} thread must accept a first turn`);
  }
}

test("starting a fresh thread removes the conversation and leaves the workspace files alone", async () => {
  const control = await supervisor("fresh-thread");
  const workspace = await workspaceWithTurnOutput();
  await threadWithConversation(control, "sample-project-one");
  const filesBefore = sortedFiles(workspace);
  const callsBefore = workspace.requests.length;

  const fresh = await control.startFreshProjectThread("sample-project-one");
  const after = await control.getProjectThread("sample-project-one");

  // The project's files are exactly what the turn left behind, and the reset asked the workspace
  // for nothing: a fresh thread replaces the conversation, not the machine it ran on (ADR-0038).
  expect(sortedFiles(workspace)).toEqual(filesBefore);
  expect(workspace.requests.length, "a fresh thread must not call the workspace").toBe(callsBefore);

  // The conversation is gone. A reset that wrote nothing would pass the two assertions above.
  // The revision advances past the replaced conversation rather than counting turns again from
  // zero, which is what stops a caller holding the old number from writing into the replacement.
  expect(fresh).toEqual({
    ok: true,
    thread: {
      projectId: "sample-project-one",
      conversation: "[]",
      messageCount: 0,
      revision: 2,
      turnActive: false,
      turnDeadlineAt: undefined,
    },
  });
  expect(after).toEqual(fresh);
});

test("a fresh thread frees the turn slot the replaced conversation held", async () => {
  const control = await supervisor("fresh-thread-releases-turn");
  await threadWithConversation(control, "sample-project-one");
  const heldLease = await admit(control, "sample-project-one", 1);

  await control.startFreshProjectThread("sample-project-one");

  // The turn that was running cannot commit into the thread it no longer holds, and the next turn
  // starts from the fresh thread's revision rather than waiting for the old lease to expire.
  const lateFinish = await finishProjectTurn(
    control,
    "sample-project-one",
    heldLease,
    savedConversation,
    NOW,
  );
  const restarted = await startProjectTurn(control, "sample-project-one", 2, NOW, LEASE_MS);

  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "sample-project-one" },
  });
  expect(restarted).toMatchObject({ ok: true, thread: { conversation: "[]", revision: 2 } });
});

test("a delayed start cannot enter a replaced thread by presenting its old revision", async () => {
  const control = await supervisor("fresh-thread-reset-race");
  // Nothing has been committed, so the running turn holds the thread at revision zero: the one
  // number a replacement would count back to if a fresh thread restarted the count.
  const staleLease = await admit(control, "sample-project-one", 0);

  await control.startFreshProjectThread("sample-project-one");

  const delayedStart = await startProjectTurn(control, "sample-project-one", 0, NOW + 1, LEASE_MS);
  const lateFinish = await finishProjectTurn(
    control,
    "sample-project-one",
    staleLease,
    savedConversation,
    NOW + 1,
  );
  const lateAbandon = await abandonProjectTurn(control, "sample-project-one", staleLease);

  expect(delayedStart).toEqual({
    ok: false,
    problem: { code: "stale-revision", projectId: "sample-project-one", currentRevision: 1 },
  });
  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "sample-project-one" },
  });
  expect(lateAbandon).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "sample-project-one" },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { conversation: "[]", messageCount: 0, revision: 1, turnActive: false },
  });
});

test("the replaced thread's lease cannot save into the turn that replaced it", async () => {
  const control = await supervisor("fresh-thread-lease-fenced");
  const staleLease = await admit(control, "sample-project-one", 0);
  await control.startFreshProjectThread("sample-project-one");

  // The coordinator of the later turn holds a lease of its own on a thread the replaced turn
  // cannot name: its predecessor's save is refused while its own succeeds.
  const freshLease = await admit(control, "sample-project-one", 1);
  const staleSave = await finishProjectTurn(
    control,
    "sample-project-one",
    staleLease,
    savedConversation,
    NOW,
  );
  const freshSave = await finishProjectTurn(
    control,
    "sample-project-one",
    freshLease,
    savedConversation,
    NOW,
  );

  expect(staleLease).not.toEqual(freshLease);
  expect(staleSave).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(freshSave).toMatchObject({
    ok: true,
    thread: { revision: 2, messageCount: savedConversation.length },
  });
});

test("a fresh thread for one project leaves the other project's thread alone", async () => {
  const control = await supervisor("fresh-thread-one-project");
  await threadWithConversation(control, "sample-project-one");
  await threadWithConversation(control, "sample-project-two");

  await control.startFreshProjectThread("sample-project-one");

  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { conversation: "[]", messageCount: 0, revision: 2 },
  });
  expect(await control.getProjectThread("sample-project-two")).toMatchObject({
    ok: true,
    thread: { conversation: JSON.stringify(savedConversation), revision: 1 },
  });
});

test("the harness entry has a thread of its own, and resetting it leaves a project's alone", async () => {
  const control = await supervisor("fresh-thread-harness");
  await threadWithConversation(control, "harness");
  await threadWithConversation(control, "sample-project-one");

  await control.startFreshProjectThread("harness");

  // One current conversation per thing the owner can be working in, and the harness is one of
  // them: its reset is the same reset, and it reaches nothing but its own row.
  expect(await control.getProjectThread("harness")).toMatchObject({
    ok: true,
    thread: { projectId: "harness", conversation: "[]", messageCount: 0, revision: 2 },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { conversation: JSON.stringify(savedConversation), revision: 1 },
  });
});

test("a fresh thread is refused for a project the catalog does not have", async () => {
  const control = await supervisor("fresh-thread-unknown-project");

  expect(await control.startFreshProjectThread("project-nine")).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});

afterEach(async () => {
  await reset();
});
