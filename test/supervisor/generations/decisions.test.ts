import { expect, test } from "vitest";

import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  decideActivation,
  decidePreparationCheck,
  type GenerationState,
} from "../../../src/supervisor/generations/decisions.js";
import {
  type Generation,
  type GenerationStatus,
} from "../../../src/supervisor/generations/index.js";
import { label } from "./fixtures.js";

// Workerd-native coverage for the pure deciders, sibling to decisions.props.test.ts (which runs
// the same rules as Hegel properties under Node). These are example-based on purpose.

const COMMIT = testHarnessCommit("a".repeat(40));

function generation(labelValue: number, status: GenerationStatus): Generation {
  return { label: label(labelValue), harnessCommit: COMMIT, status };
}

function stateAt(epoch: number, activeLabel?: number): GenerationState {
  return { activeLabel: activeLabel === undefined ? undefined : label(activeLabel), epoch };
}

test("activation rejects an unknown generation", () => {
  expect(decideActivation(label(3), undefined, stateAt(5))).toEqual({
    kind: "rejected",
    problem: { code: "unknown-generation", label: 3 },
  });
});

test("activation rejects a generation that is not ready", () => {
  expect(decideActivation(label(1), generation(1, "candidate"), stateAt(5))).toEqual({
    kind: "rejected",
    problem: { code: "not-ready", label: 1 },
  });
});

test("activating the already-active generation is a no-op that leaves the epoch alone", () => {
  expect(decideActivation(label(1), generation(1, "ready"), stateAt(5, 1))).toEqual({
    kind: "no-op",
    generation: generation(1, "ready"),
    epoch: 5,
  });
});

test("activating a ready generation advances the epoch by one", () => {
  expect(decideActivation(label(2), generation(2, "ready"), stateAt(5, 1))).toEqual({
    kind: "activate",
    generation: generation(2, "ready"),
    nextEpoch: 6,
  });
});

test("a check on a candidate records the resulting status and advances the epoch", () => {
  expect(
    decidePreparationCheck(label(1), "passed", generation(1, "candidate"), stateAt(5)),
  ).toEqual({
    kind: "record",
    generation: generation(1, "ready"),
    statusUpdate: "ready",
    nextEpoch: 6,
    effect: "recorded",
  });
});

test("a check confirming the recorded status is a no-op that still advances the epoch", () => {
  expect(decidePreparationCheck(label(1), "passed", generation(1, "ready"), stateAt(5))).toEqual({
    kind: "record",
    generation: generation(1, "ready"),
    statusUpdate: undefined,
    nextEpoch: 6,
    effect: "no-op",
  });
});

test("a check contradicting the recorded status replaces it", () => {
  expect(decidePreparationCheck(label(1), "failed", generation(1, "ready"), stateAt(5))).toEqual({
    kind: "record",
    generation: generation(1, "failed"),
    statusUpdate: "failed",
    nextEpoch: 6,
    effect: "recorded",
  });
});
