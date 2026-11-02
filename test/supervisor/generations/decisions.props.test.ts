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

test("a check records the outcome's status and compatibility, advances the epoch by one, and is a no-op only when nothing changed", () => {
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

    expect(decidePreparation(previous, outcome, { activeLabel: undefined, epoch })).toEqual({
      record: {
        generation: generation(target, outcome.status),
        wasActive,
        compatibility: checkedCompatibility,
      },
      epoch: epoch + 1,
      effect:
        previousStatus === outcome.status && previousCompatibility === checkedCompatibility
          ? "no-op"
          : "recorded",
    });
  });
});
