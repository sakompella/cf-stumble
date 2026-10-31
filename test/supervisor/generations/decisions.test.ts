import { expect, test } from "vitest";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  decideActivation,
  decidePreparation,
  type Generation,
  type GenerationRecord,
  type GenerationStatus,
  type Selection,
} from "../../../src/supervisor/generations.js";
import { label } from "./fixtures.js";

const COMMIT = testHarnessCommit("a".repeat(40));

function generation(labelValue: number, status: GenerationStatus): Generation {
  return { label: label(labelValue), harnessCommit: COMMIT, status };
}

function stored(labelValue: number, status: GenerationStatus, wasActive = false): GenerationRecord {
  return { generation: generation(labelValue, status), wasActive };
}

function selectionAt(epoch: number, activeLabel?: number): Selection {
  return { activeLabel: activeLabel === undefined ? undefined : label(activeLabel), epoch };
}

function activate(labelValue: number, observedEpoch: number) {
  return { kind: "activate", label: label(labelValue), observedEpoch } as const;
}

function rollback(labelValue: number, observedEpoch: number) {
  return { kind: "rollback", label: label(labelValue), observedEpoch } as const;
}

test("activation refuses a stale epoch before it looks at the target", () => {
  expect(decideActivation(activate(3, 4), undefined, selectionAt(5))).toEqual({
    ok: false,
    problem: { code: "stale-epoch" },
  });
});

test("activation refuses an unknown generation", () => {
  expect(decideActivation(activate(3, 5), undefined, selectionAt(5))).toEqual({
    ok: false,
    problem: { code: "unknown-generation" },
  });
});

test("activation refuses a generation that is not ready", () => {
  expect(decideActivation(activate(1, 5), stored(1, "candidate"), selectionAt(5))).toEqual({
    ok: false,
    problem: { code: "not-ready" },
  });
});

test("rollback refuses a ready generation that was never active", () => {
  expect(decideActivation(rollback(1, 5), stored(1, "ready"), selectionAt(5, 0))).toEqual({
    ok: false,
    problem: { code: "not-previously-active" },
  });
});

test("activating the already-active generation is a no-op that leaves the epoch alone", () => {
  expect(decideActivation(activate(1, 5), stored(1, "ready", true), selectionAt(5, 1))).toEqual({
    ok: true,
    outcome: { kind: "activated", generation: generation(1, "ready"), epoch: 5, effect: "no-op" },
  });
});

test("rolling back to a previously active generation advances the epoch by one", () => {
  expect(decideActivation(rollback(0, 5), stored(0, "ready", true), selectionAt(5, 1))).toEqual({
    ok: true,
    outcome: {
      kind: "rolled-back",
      generation: generation(0, "ready"),
      epoch: 6,
      effect: "activated",
    },
  });
});

test("a check on a candidate records the resulting status and advances the epoch", () => {
  expect(decidePreparation(generation(1, "candidate"), "passed", selectionAt(5))).toEqual({
    generation: generation(1, "ready"),
    epoch: 6,
    effect: "recorded",
  });
});

test("a check confirming the recorded status is a no-op that still advances the epoch", () => {
  expect(decidePreparation(generation(1, "ready"), "passed", selectionAt(5))).toEqual({
    generation: generation(1, "ready"),
    epoch: 6,
    effect: "no-op",
  });
});

test("a check contradicting the recorded status replaces it", () => {
  expect(decidePreparation(generation(1, "ready"), "failed", selectionAt(5))).toEqual({
    generation: generation(1, "failed"),
    epoch: 6,
    effect: "recorded",
  });
});
