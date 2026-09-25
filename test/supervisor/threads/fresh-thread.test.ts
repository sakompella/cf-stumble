/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { connectedSupervisor as supervisor } from "../helpers.js";
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

test("starting a fresh thread removes the conversation without calling workspace reset", async () => {
  const control = await supervisor("fresh-thread");
  await threadWithConversation(control, "sample-project-one");
  const resetWorkspace = vi.fn(() => Promise.resolve({ ok: true, reset: "workspace" } as const));

  // SAFETY: this fake implements the only Workspace Host RPC this test observes.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const workspace = { reset: resetWorkspace } as unknown as ReturnType<
    typeof env.WORKSPACE_HOST.getByName
  >;

  const getByName = vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(workspace);

  try {
    const fresh = await control.startFreshProjectThread("sample-project-one");

    // `startFreshProjectThread` deliberately does not await workspace work. Let a queued reset run
    // before checking the recording stub, so this test observes the fire-and-forget mutation too.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(getByName).not.toHaveBeenCalled();
    expect(resetWorkspace).not.toHaveBeenCalled();
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
    expect(await control.getProjectThread("sample-project-one")).toEqual(fresh);
  } finally {
    getByName.mockRestore();
  }
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
