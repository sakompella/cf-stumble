import { expect, test } from "vitest";
import {
  decideAbandonTurn,
  decideFinishTurn,
  decideStartTurn,
  type TurnLeaseClaim,
} from "../../../src/supervisor/threads/decisions.js";
import { emptyThread, type ProjectThread } from "../../../src/supervisor/threads/index.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

const NOW = 1_000_000;
const LEASE_MS = 30_000;

const firstProject = sampleProjectOne;
const projectId = firstProject.id;

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];

const ADMITTED_LEASE = "lease-a";
const REPLACEMENT_LEASE = "lease-b";

function thread(overrides: Partial<ProjectThread> = {}): ProjectThread {
  return {
    projectId,
    messages: conversation,
    revision: 3,
    turnActive: false,
    turnDeadlineAt: undefined,
    ...overrides,
  };
}

function held(overrides: Partial<ProjectThread> = {}): ProjectThread {
  return thread({ turnActive: true, turnDeadlineAt: NOW + LEASE_MS, ...overrides });
}

/** What the row holds against what the caller returned. */
function claim(heldLease: string | undefined, presented: string): TurnLeaseClaim {
  return { held: heldLease, presented };
}

const ownClaim = claim(ADMITTED_LEASE, ADMITTED_LEASE);

test("starting a turn on a thread nobody has written to accepts revision zero", () => {
  expect(decideStartTurn(projectId, emptyThread(projectId), 0, NOW)).toEqual({
    kind: "started",
    revision: 0,
  });
});

test("starting a turn with a stale revision is rejected and reports the current one", () => {
  expect(decideStartTurn(projectId, thread(), 1, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "stale-revision", projectId, currentRevision: 3 },
  });
});

test("starting a turn while one is already active is a conflict, not a stale revision", () => {
  expect(decideStartTurn(projectId, held(), 3, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-conflict", projectId, deadlineAt: NOW + LEASE_MS },
  });
});

test("a matching revision starts the turn", () => {
  expect(decideStartTurn(projectId, thread(), 3, NOW)).toEqual({ kind: "started", revision: 3 });
});

test("finishing a turn on a thread with no active turn is rejected", () => {
  expect(decideFinishTurn(projectId, thread({ turnActive: false }), ownClaim, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", projectId },
  });
});

test("finishing an active turn with another turn's lease is rejected", () => {
  const late = claim(REPLACEMENT_LEASE, ADMITTED_LEASE);

  expect(decideFinishTurn(projectId, held(), late, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-lease-lost", projectId },
  });
});

test("a row holding no lease owns no turn, whatever the caller presents", () => {
  expect(decideFinishTurn(projectId, held(), claim(undefined, ADMITTED_LEASE), NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-lease-lost", projectId },
  });
});

test("finishing an active turn with the lease that admitted it advances the revision by one", () => {
  expect(decideFinishTurn(projectId, held(), ownClaim, NOW)).toEqual({
    kind: "finished",
    nextRevision: 4,
  });
});

test("abandoning a turn on a thread with no active turn is rejected", () => {
  expect(decideAbandonTurn(projectId, thread({ turnActive: false }), ownClaim)).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", projectId },
  });
});

test("abandoning an active turn with another turn's lease is rejected", () => {
  const late = claim(REPLACEMENT_LEASE, ADMITTED_LEASE);

  expect(decideAbandonTurn(projectId, held(), late)).toEqual({
    kind: "rejected",
    problem: { code: "turn-lease-lost", projectId },
  });
});

test("abandoning an active turn with the lease that admitted it frees the slot", () => {
  expect(decideAbandonTurn(projectId, held(), ownClaim)).toEqual({ kind: "abandoned" });
});

test("the lease that ran past its deadline may still release the slot it holds", () => {
  expect(decideAbandonTurn(projectId, held({ turnDeadlineAt: NOW - 1 }), ownClaim)).toEqual({
    kind: "abandoned",
  });
});

test("a turn whose deadline has passed no longer holds the thread", () => {
  expect(decideStartTurn(projectId, held(), 3, NOW + LEASE_MS)).toEqual({
    kind: "started",
    revision: 3,
  });
});

test("finishing after the deadline is expired, not merely stale", () => {
  expect(decideFinishTurn(projectId, held(), ownClaim, NOW + LEASE_MS)).toEqual({
    kind: "rejected",
    problem: { code: "turn-expired", projectId, deadlineAt: NOW + LEASE_MS },
  });
});
