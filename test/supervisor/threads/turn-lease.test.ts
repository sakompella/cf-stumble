/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { connectSampleProjects } from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

/**
 * Turn completion is keyed by the lease that admitted the turn.
 *
 * A revision cannot tell an expired turn from its replacement: a turn that took the slot over
 * begins at the revision its predecessor was admitted at, so both hold the same number until one
 * of them commits. These tests hold the interesting half of that: what the turn that lost the
 * thread can still do to the turn that has it.
 */

const NOW = 1_700_000_000_000;
const LEASE_MS = 30_000;
const AFTER_LEASE = NOW + LEASE_MS;

const turnA = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];
const turnB = [...turnA, THREAD_MESSAGE_SAMPLES.bashExecution];

/**
 * A Supervisor holding the tenant's two connected projects. The catalog is storage now, so a test
 * that names a project has to connect it first, exactly as the owner does.
 */
async function supervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await connectSampleProjects(control);
  return control;
}

/** Admit a turn and keep the lease it returns, which is the only key its completion accepts. */
async function admit(
  control: DurableObjectStub<Supervisor>,
  expectedRevision: number,
  now: number,
): Promise<string> {
  const started = await control.startProjectTurn(
    "sample-project-one",
    expectedRevision,
    now,
    LEASE_MS,
  );
  if (!started.ok) {
    throw new Error(`the turn must be admitted: ${started.problem.code}`);
  }
  return started.leaseId;
}

/** Turn A is admitted, runs past its deadline, and turn B takes the slot over at the same revision. */
async function takenOver(
  control: DurableObjectStub<Supervisor>,
): Promise<{ readonly leaseA: string; readonly leaseB: string }> {
  const leaseA = await admit(control, 0, NOW);
  const leaseB = await admit(control, 0, AFTER_LEASE);
  return { leaseA, leaseB };
}

afterEach(async () => {
  await reset();
});

test("a finish presenting a lease the store never issued is refused", async () => {
  const control = await supervisor("turn-lease-invented");
  const lease = await admit(control, 0, NOW);

  const invented = await control.finishProjectTurn(
    "sample-project-one",
    "lease-of-my-own",
    turnA,
    NOW,
  );
  const admitted = await control.finishProjectTurn("sample-project-one", lease, turnA, NOW);

  expect(invented).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(admitted).toMatchObject({ ok: true, thread: { revision: 1, messageCount: turnA.length } });
});

test("an abandon presenting a lease the store never issued is refused", async () => {
  const control = await supervisor("turn-lease-invented-abandon");
  const lease = await admit(control, 0, NOW);

  const invented = await control.abandonProjectTurn("sample-project-one", "lease-of-my-own");
  const admitted = await control.abandonProjectTurn("sample-project-one", lease);

  expect(invented).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(admitted).toMatchObject({ ok: true, thread: { turnActive: false } });
});

test("a late finish from the replaced turn cannot save into the turn that took over", async () => {
  const control = await supervisor("turn-lease-late-finish");
  const { leaseA, leaseB } = await takenOver(control);

  const lateFinish = await control.finishProjectTurn(
    "sample-project-one",
    leaseA,
    turnA,
    AFTER_LEASE,
  );
  const ownFinish = await control.finishProjectTurn(
    "sample-project-one",
    leaseB,
    turnB,
    AFTER_LEASE,
  );

  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(ownFinish).toMatchObject({
    ok: true,
    thread: { revision: 1, conversation: JSON.stringify(turnB) },
  });
});

test("a late abandon from the replaced turn cannot free the slot the takeover holds", async () => {
  const control = await supervisor("turn-lease-late-abandon");
  const { leaseA, leaseB } = await takenOver(control);

  const lateAbandon = await control.abandonProjectTurn("sample-project-one", leaseA);
  const stillHeld = await control.getProjectThread("sample-project-one");
  const ownFinish = await control.finishProjectTurn(
    "sample-project-one",
    leaseB,
    turnB,
    AFTER_LEASE,
  );

  expect(lateAbandon).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(stillHeld).toMatchObject({
    ok: true,
    thread: { turnActive: true, turnDeadlineAt: AFTER_LEASE + LEASE_MS },
  });
  expect(ownFinish).toMatchObject({ ok: true, thread: { revision: 1 } });
});

test("a lease dies with the turn it admitted and cannot be presented twice", async () => {
  const control = await supervisor("turn-lease-spent");
  const lease = await admit(control, 0, NOW);
  await control.finishProjectTurn("sample-project-one", lease, turnA, NOW);

  const replayedFinish = await control.finishProjectTurn("sample-project-one", lease, turnB, NOW);
  const replayedAbandon = await control.abandonProjectTurn("sample-project-one", lease);

  expect(replayedFinish).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "sample-project-one" },
  });
  expect(replayedAbandon).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "sample-project-one" },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { revision: 1, conversation: JSON.stringify(turnA) },
  });
});

test("the turn that owns an expired lease may still release the slot nobody took", async () => {
  const control = await supervisor("turn-lease-expired-abandon");
  const lease = await admit(control, 0, NOW);

  const released = await control.abandonProjectTurn("sample-project-one", lease);

  expect(released).toMatchObject({ ok: true, thread: { turnActive: false, revision: 0 } });
});

test("a finish holding a completed turn's lease is rejected and leaves the conversation untouched", async () => {
  const control = await supervisor("turn-lease-completed-turn");
  const leaseA = await admit(control, 0, NOW);
  await control.finishProjectTurn("sample-project-one", leaseA, turnA, NOW);
  await admit(control, 1, NOW);

  const staleFinish = await control.finishProjectTurn("sample-project-one", leaseA, turnB, NOW);

  expect(staleFinish).toEqual({
    ok: false,
    problem: { code: "turn-lease-lost", projectId: "sample-project-one" },
  });
  expect(await control.getProjectThread("sample-project-one")).toEqual({
    ok: true,
    thread: {
      projectId: "sample-project-one",
      conversation: JSON.stringify(turnA),
      messageCount: turnA.length,
      revision: 1,
      turnActive: true,
      turnDeadlineAt: NOW + LEASE_MS,
    },
  });
});
