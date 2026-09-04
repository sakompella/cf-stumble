import { expect, test } from "vitest";
import {
  decideAbandonTurn,
  decideFinishTurn,
  decideStartTurn,
} from "../../../src/supervisor/threads/decisions.js";
import { emptyThread, type ProjectThread } from "../../../src/supervisor/threads/index.js";
import { PROJECT_CATALOG } from "../../../src/project-catalog.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

const NOW = 1_000_000;
const LEASE_MS = 30_000;

const [firstProject] = PROJECT_CATALOG;
const projectId = firstProject.id;

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];

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
  expect(decideFinishTurn(projectId, thread({ turnActive: false }), 3, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", projectId },
  });
});

test("finishing an active turn with a stale revision is rejected and leaves the write undone", () => {
  expect(decideFinishTurn(projectId, held(), 9, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "stale-revision", projectId, currentRevision: 3 },
  });
});

test("finishing an active turn with the current revision advances it by one", () => {
  expect(decideFinishTurn(projectId, held(), 3, NOW)).toEqual({
    kind: "finished",
    nextRevision: 4,
  });
});

test("abandoning a turn on a thread with no active turn is rejected", () => {
  expect(decideAbandonTurn(projectId, thread({ turnActive: false }))).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", projectId },
  });
});

test("abandoning an active turn frees the slot", () => {
  expect(decideAbandonTurn(projectId, held())).toEqual({ kind: "abandoned" });
});

test("a turn whose deadline has passed no longer holds the thread", () => {
  expect(decideStartTurn(projectId, held(), 3, NOW + LEASE_MS)).toEqual({
    kind: "started",
    revision: 3,
  });
});

test("finishing after the deadline is expired, not merely stale", () => {
  expect(decideFinishTurn(projectId, held(), 3, NOW + LEASE_MS)).toEqual({
    kind: "rejected",
    problem: { code: "turn-expired", projectId, deadlineAt: NOW + LEASE_MS },
  });
});
