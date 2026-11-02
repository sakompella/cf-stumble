import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  decideActivation,
  decidePreparation,
  type Generation,
  type GenerationStatus,
} from "../../../src/supervisor/generations.js";
import { label } from "./fixtures.js";

const COMMIT = testHarnessCommit("a".repeat(40));

function generation(labelValue: number, status: GenerationStatus): Generation {
  return { label: label(labelValue), harnessCommit: COMMIT, status };
}

const SUPERVISOR_COMPATIBILITY = "pi-durable@1.4.0/host-2";

const count = gs.integers({ minValue: 0, maxValue: 2 ** 40 });

const labelValue = gs.integers({ minValue: 0, maxValue: 2 ** 39 });

const kind = gs.sampledFrom(["activate", "rollback"] as const);

const recordedCompatibility = gs.sampledFrom([
  SUPERVISOR_COMPATIBILITY,
  "pi-durable@1.4.0/host-1",
  undefined,
] as const);

const foreignCompatibility = gs.oneOf(
  gs.sampledFrom(["pi-durable@1.4.0/host-1", "pi-durable@1.4.0", undefined] as const),
  gs.text({ maxSize: 12 }).filter((text) => text !== SUPERVISOR_COMPATIBILITY),
);

function drawDefectiveActivation(tc: hegel.TestCase) {
  const epoch = tc.draw(count);
  const target = tc.draw(labelValue);
  const commandKind = tc.draw(kind);
  const stale = tc.draw(gs.booleans());
  const unknown = tc.draw(gs.booleans());
  const notReady = tc.draw(gs.booleans());
  const neverActive = tc.draw(gs.booleans());
  const mismatched = tc.draw(gs.booleans());
  const observedOffset = tc.draw(gs.integers({ minValue: -1_000, maxValue: 1_000 }));
  tc.assume(!stale || observedOffset !== 0);

  const record = unknown
    ? undefined
    : {
        generation: generation(
          target,
          notReady ? tc.draw(gs.sampledFrom(["candidate", "failed"] as const)) : "ready",
        ),
        wasActive: !neverActive,
        compatibility: mismatched ? tc.draw(foreignCompatibility) : SUPERVISOR_COMPATIBILITY,
      };

  const present = [
    ...(stale ? (["stale-epoch"] as const) : []),
    ...(unknown ? (["unknown-generation"] as const) : []),
    ...(!unknown && notReady ? (["not-ready"] as const) : []),
    ...(!unknown && neverActive && commandKind === "rollback"
      ? (["not-previously-active"] as const)
      : []),
    ...(!unknown && mismatched ? (["facet-compatibility-mismatch"] as const) : []),
  ];

  const command = {
    kind: commandKind,
    label: label(target),
    observedEpoch: stale ? epoch + observedOffset : epoch,
  };

  return { command, record, selection: { activeLabel: undefined, epoch }, present };
}

test("a refused activation reports its defect, a stale epoch first, and an accepted one has none", () => {
  hegel.test(
    (tc) => {
      const { command, record, selection, present } = drawDefectiveActivation(tc);
      const decision = decideActivation(command, record, selection, SUPERVISOR_COMPATIBILITY);

      if (present.length === 0) {
        expect(decision).toMatchObject({
          ok: true,
          outcome: { kind: command.kind === "activate" ? "activated" : "rolled-back" },
        });
      } else if (command.observedEpoch !== selection.epoch) {
        expect(decision).toEqual({ ok: false, problem: { code: "stale-epoch" } });
      } else if (present.length === 1) {
        expect(decision).toEqual({ ok: false, problem: { code: present[0] } });
      } else {
        expect(decision.ok ? [] : present).toContain(decision.ok ? "" : decision.problem.code);
      }
    },
    { testCases: 500 },
  );
});

test("an accepted activation advances the epoch by exactly one, and only when it changes the selection", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const active = tc.draw(gs.sampledFrom(["none", "same", "other"] as const));

    const activeLabel =
      active === "none" ? undefined : label(active === "same" ? target : target + 1);

    const ready = generation(target, "ready");
    const command = { kind: tc.draw(kind), label: label(target), observedEpoch: epoch };

    const decision = decideActivation(
      command,
      { generation: ready, wasActive: true, compatibility: SUPERVISOR_COMPATIBILITY },
      { activeLabel, epoch },
      SUPERVISOR_COMPATIBILITY,
    );

    expect(decision).toMatchObject(
      active === "same"
        ? { ok: true, outcome: { generation: ready, epoch, effect: "no-op" } }
        : { ok: true, outcome: { generation: ready, epoch: epoch + 1, effect: "activated" } },
    );
  });
});

test("a check records the outcome's status and compatibility and advances the epoch by one, unless nothing changed, which is a no-op that keeps it", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const previousStatus = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));
    const previousCompatibility = tc.draw(recordedCompatibility);
    const checkedCompatibility = tc.draw(recordedCompatibility);
    const wasActive = tc.draw(gs.booleans());

    const outcome =
      checkedCompatibility === undefined
        ? ({ status: "failed" } as const)
        : ({ status: "ready", compatibility: checkedCompatibility } as const);

    const previous = {
      generation: generation(target, previousStatus),
      wasActive,
      compatibility: previousCompatibility,
    };

    const unchanged =
      previousStatus === outcome.status && previousCompatibility === checkedCompatibility;

    expect(decidePreparation(previous, outcome, { activeLabel: undefined, epoch })).toEqual({
      record: {
        generation: generation(target, outcome.status),
        wasActive,
        compatibility: checkedCompatibility,
      },
      epoch: unchanged ? epoch : epoch + 1,
      effect: unchanged ? "no-op" : "recorded",
    });
  });
});

test("a current command is accepted exactly when its target is ready with the current compatibility and, for a rollback, was active", () => {
  hegel.test(
    (tc) => {
      const epoch = tc.draw(count);
      const target = tc.draw(labelValue);

      const record = {
        generation: generation(
          target,
          tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const)),
        ),
        wasActive: tc.draw(gs.booleans()),
        compatibility: tc.draw(recordedCompatibility),
      };

      const command = { kind: tc.draw(kind), label: label(target), observedEpoch: epoch };
      const activeLabel = tc.draw(gs.booleans()) ? label(target) : undefined;

      const decision = decideActivation(
        command,
        record,
        { activeLabel, epoch },
        SUPERVISOR_COMPATIBILITY,
      );

      expect(decision.ok).toBe(
        record.generation.status === "ready" &&
          record.compatibility === SUPERVISOR_COMPATIBILITY &&
          (command.kind === "activate" || record.wasActive),
      );
    },
    { testCases: 300 },
  );
});
