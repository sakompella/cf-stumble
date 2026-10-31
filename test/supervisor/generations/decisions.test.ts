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

const SUPERVISOR_COMPATIBILITY = "pi-durable@1.4.0/host-2";

function stored(
  labelValue: number,
  status: GenerationStatus,
  wasActive = false,
  compatibility: string | undefined = SUPERVISOR_COMPATIBILITY,
): GenerationRecord {
  return { generation: generation(labelValue, status), wasActive, compatibility };
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
  expect(
    decideActivation(activate(3, 4), undefined, selectionAt(5), SUPERVISOR_COMPATIBILITY),
  ).toEqual({
    ok: false,
    problem: { code: "stale-epoch" },
  });
});

test("activation refuses an unknown generation", () => {
  expect(
    decideActivation(activate(3, 5), undefined, selectionAt(5), SUPERVISOR_COMPATIBILITY),
  ).toEqual({
    ok: false,
    problem: { code: "unknown-generation" },
  });
});

test("activation refuses a generation that is not ready", () => {
  expect(
    decideActivation(
      activate(1, 5),
      stored(1, "candidate"),
      selectionAt(5),
      SUPERVISOR_COMPATIBILITY,
    ),
  ).toEqual({
    ok: false,
    problem: { code: "not-ready" },
  });
});

test("rollback refuses a ready generation that was never active", () => {
  expect(
    decideActivation(
      rollback(1, 5),
      stored(1, "ready"),
      selectionAt(5, 0),
      SUPERVISOR_COMPATIBILITY,
    ),
  ).toEqual({
    ok: false,
    problem: { code: "not-previously-active" },
  });
});

test("activating the already-active generation is a no-op that leaves the epoch alone", () => {
  expect(
    decideActivation(
      activate(1, 5),
      stored(1, "ready", true),
      selectionAt(5, 1),
      SUPERVISOR_COMPATIBILITY,
    ),
  ).toEqual({
    ok: true,
    outcome: { kind: "activated", generation: generation(1, "ready"), epoch: 5, effect: "no-op" },
  });
});

test("rolling back to a previously active generation advances the epoch by one", () => {
  expect(
    decideActivation(
      rollback(0, 5),
      stored(0, "ready", true),
      selectionAt(5, 1),
      SUPERVISOR_COMPATIBILITY,
    ),
  ).toEqual({
    ok: true,
    outcome: {
      kind: "rolled-back",
      generation: generation(0, "ready"),
      epoch: 6,
      effect: "activated",
    },
  });
});

test("activation and rollback refuse a generation checked under another facet compatibility", () => {
  const checkedElsewhere = stored(0, "ready", true, "pi-durable@1.4.0/host-1");

  for (const command of [activate(0, 5), rollback(0, 5)]) {
    expect(
      decideActivation(command, checkedElsewhere, selectionAt(5, 1), SUPERVISOR_COMPATIBILITY),
    ).toEqual({ ok: false, problem: { code: "facet-compatibility-mismatch" } });
  }
});

test("activation refuses a generation with no recorded facet compatibility", () => {
  expect(
    decideActivation(
      activate(0, 5),
      { ...stored(0, "ready", true), compatibility: undefined },
      selectionAt(5, 1),
      SUPERVISOR_COMPATIBILITY,
    ),
  ).toEqual({ ok: false, problem: { code: "facet-compatibility-mismatch" } });
});

const passed = { status: "ready", compatibility: SUPERVISOR_COMPATIBILITY } as const;

test("a check on a candidate records the resulting status and compatibility and advances the epoch", () => {
  expect(
    decidePreparation(
      { ...stored(1, "candidate"), compatibility: undefined },
      passed,
      selectionAt(5),
    ),
  ).toEqual({ record: stored(1, "ready"), epoch: 6, effect: "recorded" });
});

test("a check confirming the recorded status and compatibility is a no-op that still advances the epoch", () => {
  expect(decidePreparation(stored(1, "ready"), passed, selectionAt(5))).toEqual({
    record: stored(1, "ready"),
    epoch: 6,
    effect: "no-op",
  });
});

test("a passing check under a new facet compatibility replaces the recorded one", () => {
  expect(
    decidePreparation(stored(1, "ready", true, "pi-durable@1.4.0/host-1"), passed, selectionAt(5)),
  ).toEqual({
    record: stored(1, "ready", true),
    epoch: 6,
    effect: "recorded",
  });
});

test("a failed check replaces the recorded status and clears the compatibility", () => {
  expect(decidePreparation(stored(1, "ready"), { status: "failed" }, selectionAt(5))).toEqual({
    record: { ...stored(1, "failed"), compatibility: undefined },
    epoch: 6,
    effect: "recorded",
  });
});
