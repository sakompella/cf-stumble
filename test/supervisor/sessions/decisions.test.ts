import { expect, test } from "vitest";

import {
  decideAbandonTurn,
  decideFinishTurn,
  decideStartTurn,
} from "../../../src/supervisor/sessions/decisions.js";
import type { SessionRecord } from "../../../src/supervisor/sessions/session.js";

const NOW = 1_000_000;
const LEASE_MS = 30_000;

function held(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return record({ turnActive: true, turnDeadlineAt: NOW + LEASE_MS, ...overrides });
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session-a",
    document: "conversation-v1",
    revision: 3,
    turnActive: false,
    turnDeadlineAt: undefined,
    ...overrides,
  };
}

test("starting a turn on an unknown session accepts revision zero", () => {
  expect(decideStartTurn("new-session", undefined, 0, NOW)).toEqual({
    kind: "started",
    revision: 0,
    document: undefined,
  });
});

test("starting a turn with a stale revision is rejected and reports the current one", () => {
  expect(decideStartTurn("session-a", record(), 1, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 3 },
  });
});

test("starting a turn while one is already active is a conflict, not a stale revision", () => {
  expect(decideStartTurn("session-a", held(), 3, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-conflict", sessionId: "session-a", deadlineAt: NOW + LEASE_MS },
  });
});

test("a matching revision starts the turn and carries the existing document forward", () => {
  expect(decideStartTurn("session-a", record(), 3, NOW)).toEqual({
    kind: "started",
    revision: 3,
    document: "conversation-v1",
  });
});

test("finishing a turn on a session with no active turn is rejected", () => {
  expect(decideFinishTurn("session-a", record({ turnActive: false }), 3, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", sessionId: "session-a" },
  });
});

test("finishing a turn on an unknown session is rejected", () => {
  expect(decideFinishTurn("session-a", undefined, 0, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", sessionId: "session-a" },
  });
});

test("finishing an active turn with a stale revision is rejected and leaves the write undone", () => {
  expect(decideFinishTurn("session-a", held(), 9, NOW)).toEqual({
    kind: "rejected",
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 3 },
  });
});

test("finishing an active turn with the current revision advances it by one", () => {
  expect(decideFinishTurn("session-a", held(), 3, NOW)).toEqual({
    kind: "finished",
    nextRevision: 4,
  });
});

test("abandoning a turn on a session with no active turn is rejected", () => {
  expect(decideAbandonTurn("session-a", record({ turnActive: false }))).toEqual({
    kind: "rejected",
    problem: { code: "turn-not-active", sessionId: "session-a" },
  });
});

test("abandoning an active turn frees the slot and leaves the document and revision alone", () => {
  expect(decideAbandonTurn("session-a", held())).toEqual({
    kind: "abandoned",
    revision: 3,
    document: "conversation-v1",
  });
});

test("a turn whose deadline has passed no longer holds the session", () => {
  expect(decideStartTurn("session-a", held(), 3, NOW + LEASE_MS)).toEqual({
    kind: "started",
    revision: 3,
    document: "conversation-v1",
  });
});

test("finishing after the deadline is expired, not merely stale", () => {
  expect(decideFinishTurn("session-a", held(), 3, NOW + LEASE_MS)).toEqual({
    kind: "rejected",
    problem: { code: "turn-expired", sessionId: "session-a", deadlineAt: NOW + LEASE_MS },
  });
});
