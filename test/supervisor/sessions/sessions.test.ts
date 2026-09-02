/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "../helpers.js";

const NOW = 1_700_000_000_000;
const LEASE_MS = 30_000;

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("a write with a stale expected revision fails and leaves the stored document untouched", async () => {
  const control = supervisor("session-stale-write");
  const started = await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);
  if (!started.ok) {
    throw new Error("a fresh session must accept the first turn");
  }
  const finished = await control.finishSessionTurn("session-a", 0, "turn one", NOW);
  if (!finished.ok) {
    throw new Error("a matching revision must be accepted");
  }

  const staleWrite = await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);

  expect(staleWrite).toEqual({
    ok: false,
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 1 },
  });
  expect(Object.getPrototypeOf(staleWrite)).toBe(Object.prototype);
  expect(await control.getSession("session-a")).toEqual({
    sessionId: "session-a",
    document: "turn one",
    revision: 1,
    turnActive: false,
    turnDeadlineAt: undefined,
  });
});

test("a second start for a session with an active turn is a conflict, not a stale revision", async () => {
  const control = supervisor("session-conflicting-turn");
  const first = await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);
  if (!first.ok) {
    throw new Error("a fresh session must accept the first turn");
  }

  const second = await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);

  expect(second).toEqual({
    ok: false,
    problem: { code: "turn-conflict", sessionId: "session-a", deadlineAt: NOW + LEASE_MS },
  });
  expect(await control.getSession("session-a")).toMatchObject({ turnActive: true });
});

test("finishing or abandoning a turn frees the slot for a later start", async () => {
  const control = supervisor("session-turn-release");
  await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);
  const finished = await control.finishSessionTurn("session-a", 0, "first document", NOW);
  if (!finished.ok) {
    throw new Error("finishing the only active turn must succeed");
  }

  const restarted = await control.startSessionTurn("session-a", 1, NOW, LEASE_MS);
  if (!restarted.ok) {
    throw new Error("finishing a turn must free the slot for a later start");
  }
  const abandoned = await control.abandonSessionTurn("session-a");

  expect(abandoned).toEqual({
    ok: true,
    session: { sessionId: "session-a", document: "first document", revision: 1, turnActive: false },
  });
  expect(await control.getSession("session-a")).toMatchObject({ turnActive: false, revision: 1 });

  const startedAgain = await control.startSessionTurn("session-a", 1, NOW, LEASE_MS);
  expect(startedAgain).toMatchObject({ ok: true, session: { turnActive: true } });
});

test("two different sessions run their turns at the same time without interference", async () => {
  const control = supervisor("session-two-concurrent");

  const [startedA, startedB] = await Promise.all([
    control.startSessionTurn("session-a", 0, NOW, LEASE_MS),
    control.startSessionTurn("session-b", 0, NOW, LEASE_MS),
  ]);

  expect(startedA).toMatchObject({ ok: true, session: { sessionId: "session-a" } });
  expect(startedB).toMatchObject({ ok: true, session: { sessionId: "session-b" } });

  const [finishedA, finishedB] = await Promise.all([
    control.finishSessionTurn("session-a", 0, "document a", NOW),
    control.finishSessionTurn("session-b", 0, "document b", NOW),
  ]);

  expect(finishedA).toMatchObject({ ok: true, session: { document: "document a" } });
  expect(finishedB).toMatchObject({ ok: true, session: { document: "document b" } });
  expect(await control.getSession("session-a")).toMatchObject({ document: "document a" });
  expect(await control.getSession("session-b")).toMatchObject({ document: "document b" });
});

test("a session survives a generation change and names no generation in its stored schema", async () => {
  const control = supervisor("session-survives-generation-change");
  await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);
  const beforeChange = await control.finishSessionTurn("session-a", 0, "conversation state", NOW);
  if (!beforeChange.ok) {
    throw new Error("the first finish must succeed");
  }

  const label = await submitCandidate(control, secondHarnessCommit, "submit-next-generation");
  await prepareGeneration(control, label, secondHarnessCommit);
  await activateGeneration(control, label, "activate-next-generation");

  const afterChange = await control.getSession("session-a");

  expect(afterChange).toEqual(beforeChange.session);
  expect(Object.keys(afterChange ?? {}).toSorted()).toEqual([
    "document",
    "revision",
    "sessionId",
    "turnActive",
    "turnDeadlineAt",
  ]);
  expect((await control.getActiveGeneration()).generation).toMatchObject({
    label,
    harnessCommit: secondHarnessCommit,
  });
});

test("a stale finish is rejected and leaves the stored document untouched", async () => {
  const control = supervisor("session-stale-finish");
  await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);
  await control.finishSessionTurn("session-a", 0, "turn one", NOW);
  await control.startSessionTurn("session-a", 1, NOW, LEASE_MS);

  const staleFinish = await control.finishSessionTurn("session-a", 0, "turn two", NOW);

  expect(staleFinish).toEqual({
    ok: false,
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 1 },
  });
  expect(await control.getSession("session-a")).toEqual({
    sessionId: "session-a",
    document: "turn one",
    revision: 1,
    turnActive: true,
    turnDeadlineAt: NOW + LEASE_MS,
  });
});

test("a turn whose deadline has passed is taken over by the next start", async () => {
  const control = supervisor("session-turn-lease");
  await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);

  const duringLease = await control.startSessionTurn("session-a", 0, NOW + LEASE_MS - 1, LEASE_MS);
  const afterLease = await control.startSessionTurn("session-a", 0, NOW + LEASE_MS, LEASE_MS);

  expect(duringLease).toEqual({
    ok: false,
    problem: { code: "turn-conflict", sessionId: "session-a", deadlineAt: NOW + LEASE_MS },
  });
  expect(afterLease).toEqual({
    ok: true,
    session: {
      sessionId: "session-a",
      document: undefined,
      revision: 0,
      turnActive: true,
      turnDeadlineAt: NOW + LEASE_MS + LEASE_MS,
    },
  });
});

test("finishing a turn after its deadline is rejected and stores nothing", async () => {
  const control = supervisor("session-turn-expired");
  await control.startSessionTurn("session-a", 0, NOW, LEASE_MS);

  const lateFinish = await control.finishSessionTurn(
    "session-a",
    0,
    "written by a dead facet",
    NOW + LEASE_MS,
  );

  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-expired", sessionId: "session-a", deadlineAt: NOW + LEASE_MS },
  });
  expect(await control.getSession("session-a")).toEqual({
    sessionId: "session-a",
    document: undefined,
    revision: 0,
    turnActive: true,
    turnDeadlineAt: NOW + LEASE_MS,
  });
});
