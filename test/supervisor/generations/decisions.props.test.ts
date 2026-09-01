import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  decideActivation,
  decidePreparationCheck,
} from "../../../src/supervisor/generations/decisions.js";
import {
  parseGenerationLabel,
  type Generation,
  type GenerationLabel,
  type GenerationStatus,
} from "../../../src/supervisor/generations/index.js";

// The deciders are pure functions over plain values, so these exercise their invariants across
// generated labels, statuses, outcomes, and clock positions — no Durable Object, no storage.

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

const count = gs.integers({ minValue: 0, maxValue: 2 ** 40 });
const labelValue = gs.integers({ minValue: 0, maxValue: 2 ** 39 });

test("activation always rejects an unknown generation, whatever the clocks say", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const state = { activeLabel: undefined, epoch: tc.draw(count), activationId: tc.draw(count) };

    expect(decideActivation(label(target), undefined, state)).toEqual({
      kind: "rejected",
      problem: { code: "unknown-generation", label: target },
    });
  });
});

test("activation always rejects a generation that is not ready", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const status = tc.draw(gs.sampledFrom(["candidate", "failed"] as const));
    const state = { activeLabel: undefined, epoch: tc.draw(count), activationId: tc.draw(count) };

    expect(decideActivation(label(target), generation(target, status), state)).toEqual({
      kind: "rejected",
      problem: { code: "not-ready", label: target },
    });
  });
});

test("a ready generation advances both clocks by exactly one, and only when it is not already active", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const activationId = tc.draw(count);
    const active = tc.draw(gs.sampledFrom(["none", "same", "other"] as const));
    const activeLabel =
      active === "none" ? undefined : label(active === "same" ? target : target + 1);
    const ready = generation(target, "ready");

    const decision = decideActivation(label(target), ready, { activeLabel, epoch, activationId });

    if (active === "same") {
      expect(decision).toEqual({ kind: "no-op", generation: ready, epoch });
    } else {
      expect(decision).toEqual({
        kind: "activate",
        generation: ready,
        nextEpoch: epoch + 1,
        nextActivationId: activationId + 1,
      });
    }
  });
});

test("a preparation check with an invalid outcome is rejected for any generation or clock", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const status = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));
    const outcome = tc.draw(
      gs.sampledFrom(["", "pass", "PASSED", "Passed", "failed ", "bogus", "ready"] as const),
    );
    const state = { activeLabel: undefined, epoch: tc.draw(count), activationId: tc.draw(count) };

    expect(
      decidePreparationCheck(label(target), outcome, generation(target, status), state),
    ).toEqual({ kind: "rejected", problem: { code: "invalid-preparation-check-outcome" } });
  });
});

test("a check on a candidate records the matching status and advances the epoch by one", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const outcome = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
    const state = { activeLabel: undefined, epoch, activationId: tc.draw(count) };
    const expectedStatus: GenerationStatus = outcome === "passed" ? "ready" : "failed";

    expect(
      decidePreparationCheck(label(target), outcome, generation(target, "candidate"), state),
    ).toEqual({
      kind: "record",
      outcome,
      generation: generation(target, expectedStatus),
      statusUpdate: expectedStatus,
      nextEpoch: epoch + 1,
      effect: "recorded",
    });
  });
});

test("a check that confirms the recorded status is a no-op that still advances the epoch", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const outcome = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
    const recorded: GenerationStatus = outcome === "passed" ? "ready" : "failed";
    const settled = generation(target, recorded);
    const state = { activeLabel: undefined, epoch, activationId: tc.draw(count) };

    expect(decidePreparationCheck(label(target), outcome, settled, state)).toEqual({
      kind: "record",
      outcome,
      generation: settled,
      statusUpdate: undefined,
      nextEpoch: epoch + 1,
      effect: "no-op",
    });
  });
});

test("a check that contradicts the recorded status is rejected and reports it", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const outcome = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
    const recorded: GenerationStatus = outcome === "passed" ? "failed" : "ready";
    const state = { activeLabel: undefined, epoch: tc.draw(count), activationId: tc.draw(count) };

    expect(
      decidePreparationCheck(label(target), outcome, generation(target, recorded), state),
    ).toEqual({
      kind: "rejected",
      problem: { code: "contradicts-recorded-outcome", label: target, recorded },
    });
  });
});
