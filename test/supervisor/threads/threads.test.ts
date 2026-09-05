/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { AgentMessage } from "@cf-stumble/pi";
import { parseThreadMessages } from "../../../src/supervisor/threads/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  prepareGeneration,
  submitCandidate,
  connectSampleProjects,
} from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

const NOW = 1_700_000_000_000;
const LEASE_MS = 30_000;

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";

const firstTurn = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];
const secondTurn = [...firstTurn, THREAD_MESSAGE_SAMPLES.bashExecution];

/**
 * A Supervisor holding the tenant's two connected projects. The catalog is storage now, so a test
 * that names a project has to connect it first, exactly as the owner does.
 */
async function supervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await connectSampleProjects(control);
  return control;
}

/**
 * The conversation a thread came back holding. The Supervisor returns it in its stored form, so a
 * caller reads it back through the same parser the store writes it with.
 */
async function conversationOf(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<readonly AgentMessage[]> {
  const result = await control.getProjectThread(projectId);
  if (!result.ok) {
    throw new Error(`the ${projectId} thread must be readable: ${result.problem.code}`);
  }
  const messages = parseThreadMessages(result.thread.conversation);
  if (messages.isErr()) {
    throw new Error(`the ${projectId} conversation must parse: ${messages.error.reason}`);
  }
  return messages.value;
}

/** Admit a turn and keep the lease it returns, which is the only key its completion accepts. */
async function admit(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
  expectedRevision: number,
  now = NOW,
): Promise<string> {
  const started = await control.startProjectTurn(projectId, expectedRevision, now, LEASE_MS);
  if (!started.ok) {
    throw new Error(`the ${projectId} turn must be admitted: ${started.problem.code}`);
  }
  return started.leaseId;
}

afterEach(async () => {
  await reset();
});

test("a project the catalog does not have reaches no thread at all", async () => {
  const control = await supervisor("thread-unknown-project");

  const unknown = await control.getProjectThread("project-nine");
  const malformed = await control.getProjectThread("Project One");
  const notAString = await control.getProjectThread({ id: "sample-project-one" });
  const started = await control.startProjectTurn("project-nine", 0, NOW, LEASE_MS);

  expect(unknown).toEqual({ ok: false, problem: { code: "unknown-project-id" } });
  expect(malformed).toEqual({ ok: false, problem: { code: "invalid-project-id" } });
  expect(notAString).toEqual({ ok: false, problem: { code: "invalid-project-id" } });
  expect(started).toEqual({ ok: false, problem: { code: "unknown-project-id" } });
});

test("a catalog project has an empty thread before anything is written to it", async () => {
  const control = await supervisor("thread-empty");

  expect(await control.getProjectThread("sample-project-one")).toEqual({
    ok: true,
    thread: {
      projectId: "sample-project-one",
      conversation: "[]",
      messageCount: 0,
      revision: 0,
      turnActive: false,
      turnDeadlineAt: undefined,
    },
  });
});

test("a committed turn stores the conversation and advances the revision", async () => {
  const control = await supervisor("thread-commit");
  const lease = await admit(control, "sample-project-one", 0);

  const finished = await control.finishProjectTurn("sample-project-one", lease, firstTurn, NOW);

  expect(finished).toMatchObject({
    ok: true,
    thread: { revision: 1, turnActive: false, messageCount: firstTurn.length },
  });
  expect(await conversationOf(control, "sample-project-one")).toEqual(firstTurn);
});

test("a conversation that is not a list of Pi messages is refused and stores nothing", async () => {
  const control = await supervisor("thread-invalid-messages");
  const lease = await admit(control, "sample-project-one", 0);

  const finished = await control.finishProjectTurn(
    "sample-project-one",
    lease,
    [{ role: "telepathy", timestamp: 1 }],
    NOW,
  );

  expect(finished).toMatchObject({
    ok: false,
    problem: { code: "invalid-messages", projectId: "sample-project-one" },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { messageCount: 0, revision: 0 },
  });
});

test("a write with a stale expected revision fails and leaves the conversation untouched", async () => {
  const control = await supervisor("thread-stale-write");
  const lease = await admit(control, "sample-project-one", 0);
  await control.finishProjectTurn("sample-project-one", lease, firstTurn, NOW);

  const staleWrite = await control.startProjectTurn("sample-project-one", 0, NOW, LEASE_MS);

  expect(staleWrite).toEqual({
    ok: false,
    problem: { code: "stale-revision", projectId: "sample-project-one", currentRevision: 1 },
  });
  expect(Object.getPrototypeOf(staleWrite)).toBe(Object.prototype);
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { messageCount: firstTurn.length, revision: 1 },
  });
  expect(await conversationOf(control, "sample-project-one")).toEqual(firstTurn);
});

test("a second start for a project with an active turn is a conflict, not a stale revision", async () => {
  const control = await supervisor("thread-conflicting-turn");
  await control.startProjectTurn("sample-project-one", 0, NOW, LEASE_MS);

  const second = await control.startProjectTurn("sample-project-one", 0, NOW, LEASE_MS);

  expect(second).toEqual({
    ok: false,
    problem: { code: "turn-conflict", projectId: "sample-project-one", deadlineAt: NOW + LEASE_MS },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { turnActive: true },
  });
});

test("finishing or abandoning a turn frees the slot for a later start", async () => {
  const control = await supervisor("thread-turn-release");
  const firstLease = await admit(control, "sample-project-one", 0);
  await control.finishProjectTurn("sample-project-one", firstLease, firstTurn, NOW);
  const secondLease = await admit(control, "sample-project-one", 1);

  const abandoned = await control.abandonProjectTurn("sample-project-one", secondLease);

  expect(abandoned).toEqual({
    ok: true,
    thread: {
      projectId: "sample-project-one",
      conversation: JSON.stringify(firstTurn),
      messageCount: firstTurn.length,
      revision: 1,
      turnActive: false,
      turnDeadlineAt: undefined,
    },
  });
  expect(await control.startProjectTurn("sample-project-one", 1, NOW, LEASE_MS)).toMatchObject({
    ok: true,
    thread: { turnActive: true },
  });
});

test("the two catalog projects run their turns at the same time without interference", async () => {
  const control = await supervisor("thread-two-projects");

  const [startedOne, startedTwo] = await Promise.all([
    control.startProjectTurn("sample-project-one", 0, NOW, LEASE_MS),
    control.startProjectTurn("sample-project-two", 0, NOW, LEASE_MS),
  ]);
  if (!startedOne.ok || !startedTwo.ok) {
    throw new Error("both projects must be admitted to a turn of their own");
  }
  await Promise.all([
    control.finishProjectTurn("sample-project-one", startedOne.leaseId, firstTurn, NOW),
    control.finishProjectTurn("sample-project-two", startedTwo.leaseId, secondTurn, NOW),
  ]);

  expect(startedOne).toMatchObject({ ok: true, thread: { projectId: "sample-project-one" } });
  expect(startedTwo).toMatchObject({ ok: true, thread: { projectId: "sample-project-two" } });
  expect(startedOne.leaseId).not.toEqual(startedTwo.leaseId);
  expect(await conversationOf(control, "sample-project-one")).toEqual(firstTurn);
  expect(await conversationOf(control, "sample-project-two")).toEqual(secondTurn);
});

test("a thread survives a generation change and names no generation in its stored shape", async () => {
  const control = await supervisor("thread-survives-generation-change");
  const lease = await admit(control, "sample-project-one", 0);
  const beforeChange = await control.finishProjectTurn("sample-project-one", lease, firstTurn, NOW);
  if (!beforeChange.ok) {
    throw new Error("the first finish must succeed");
  }

  const label = await submitCandidate(control, secondHarnessCommit);
  await prepareGeneration(control, label, secondHarnessCommit);
  await activateGeneration(control, label);

  const afterChange = await control.getProjectThread("sample-project-one");
  if (!afterChange.ok) {
    throw new Error("the thread must survive the generation change");
  }

  expect(afterChange.thread).toEqual(beforeChange.thread);
  expect(Object.keys(afterChange.thread).toSorted()).toEqual([
    "conversation",
    "messageCount",
    "projectId",
    "revision",
    "turnActive",
    "turnDeadlineAt",
  ]);
});

test("a turn whose deadline has passed is taken over by the next start", async () => {
  const control = await supervisor("thread-turn-lease");
  await control.startProjectTurn("sample-project-one", 0, NOW, LEASE_MS);

  const duringLease = await control.startProjectTurn(
    "sample-project-one",
    0,
    NOW + LEASE_MS - 1,
    LEASE_MS,
  );
  const afterLease = await control.startProjectTurn(
    "sample-project-one",
    0,
    NOW + LEASE_MS,
    LEASE_MS,
  );

  expect(duringLease).toEqual({
    ok: false,
    problem: { code: "turn-conflict", projectId: "sample-project-one", deadlineAt: NOW + LEASE_MS },
  });
  expect(afterLease).toMatchObject({
    ok: true,
    thread: { turnActive: true, turnDeadlineAt: NOW + LEASE_MS + LEASE_MS },
  });
});

test("finishing a turn after its deadline is rejected and stores nothing", async () => {
  const control = await supervisor("thread-turn-expired");
  const lease = await admit(control, "sample-project-one", 0);

  const lateFinish = await control.finishProjectTurn(
    "sample-project-one",
    lease,
    firstTurn,
    NOW + LEASE_MS,
  );

  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-expired", projectId: "sample-project-one", deadlineAt: NOW + LEASE_MS },
  });
  expect(await control.getProjectThread("sample-project-one")).toMatchObject({
    ok: true,
    thread: { messageCount: 0, revision: 0, turnActive: true },
  });
});
