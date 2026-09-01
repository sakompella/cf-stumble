import { expect, test } from "vitest";

import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  decideActivation,
  decidePreparationCheck,
  type GenerationState,
} from "../../../src/supervisor/generations/decisions.js";
import {
  parseGenerationLabel,
  type Generation,
  type GenerationLabel,
  type GenerationStatus,
} from "../../../src/supervisor/generations/index.js";

// Workerd-native coverage for the pure deciders, sibling to decisions.props.test.ts (which runs
// the same rules as Hegel properties under Node). These are example-based on purpose.

function testCommit(): HarnessCommit {
  const parsed = parseHarnessCommit("a".repeat(40));
  if (parsed === undefined) {
    throw new Error("test commit must be valid");
  }
  return parsed;
}

const COMMIT = testCommit();

function label(value: number): GenerationLabel {
  const parsed = parseGenerationLabel(value);
  if (parsed === undefined) {
    throw new Error(`invalid test label ${value}`);
  }
  return parsed;
}

function generation(labelValue: number, status: GenerationStatus): Generation {
  return { label: label(labelValue), harnessCommit: COMMIT, status };
}

function stateAt(epoch: number, activationId: number, activeLabel?: number): GenerationState {
  return {
    activeLabel: activeLabel === undefined ? undefined : label(activeLabel),
    epoch,
    activationId,
  };
}

test("activation rejects an unknown generation", () => {
  expect(decideActivation(label(3), undefined, stateAt(5, 2))).toEqual({
    kind: "rejected",
    problem: { code: "unknown-generation", label: 3 },
  });
});

test("activation rejects a generation that is not ready", () => {
  expect(decideActivation(label(1), generation(1, "candidate"), stateAt(5, 2))).toEqual({
    kind: "rejected",
    problem: { code: "not-ready", label: 1 },
  });
});

test("activating the already-active generation is a no-op that leaves the clocks alone", () => {
  expect(decideActivation(label(1), generation(1, "ready"), stateAt(5, 2, 1))).toEqual({
    kind: "no-op",
    generation: generation(1, "ready"),
    epoch: 5,
  });
});

test("activating a ready generation advances epoch and activation id by one", () => {
  expect(decideActivation(label(2), generation(2, "ready"), stateAt(5, 2, 1))).toEqual({
    kind: "activate",
    generation: generation(2, "ready"),
    nextEpoch: 6,
    nextActivationId: 3,
  });
});

test("a preparation check with an invalid outcome is rejected", () => {
  expect(
    decidePreparationCheck(label(1), "bogus", generation(1, "candidate"), stateAt(5, 2)),
  ).toEqual({ kind: "rejected", problem: { code: "invalid-preparation-check-outcome" } });
});

test("a check on a candidate records the resulting status and advances the epoch", () => {
  expect(
    decidePreparationCheck(label(1), "passed", generation(1, "candidate"), stateAt(5, 2)),
  ).toEqual({
    kind: "record",
    outcome: "passed",
    generation: generation(1, "ready"),
    statusUpdate: "ready",
    nextEpoch: 6,
    effect: "recorded",
  });
});

test("a check confirming the recorded status is a no-op that still advances the epoch", () => {
  expect(decidePreparationCheck(label(1), "passed", generation(1, "ready"), stateAt(5, 2))).toEqual(
    {
      kind: "record",
      outcome: "passed",
      generation: generation(1, "ready"),
      statusUpdate: undefined,
      nextEpoch: 6,
      effect: "no-op",
    },
  );
});

test("a check contradicting the recorded status is rejected and reports it", () => {
  expect(decidePreparationCheck(label(1), "failed", generation(1, "ready"), stateAt(5, 2))).toEqual(
    {
      kind: "rejected",
      problem: { code: "contradicts-recorded-outcome", label: 1, recorded: "ready" },
    },
  );
});
