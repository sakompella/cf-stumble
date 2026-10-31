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

test("only the current epoch can change the selection, whatever the target", () => {
  hegel.test((tc) => {
    const epoch = tc.draw(count);
    const observedEpoch = tc.draw(count);
    const target = tc.draw(labelValue);
    const status = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));

    const record = {
      generation: generation(target, status),
      wasActive: tc.draw(gs.booleans()),
      compatibility: tc.draw(recordedCompatibility),
    };

    const command = { kind: tc.draw(kind), label: label(target), observedEpoch };

    const decision = decideActivation(
      command,
      record,
      { activeLabel: undefined, epoch },
      SUPERVISOR_COMPATIBILITY,
    );

    if (observedEpoch !== epoch) {
      expect(decision).toEqual({ ok: false, problem: { code: "stale-epoch" } });
    }

    if (status !== "ready") expect(decision.ok).toBe(false);

    if (record.compatibility !== SUPERVISOR_COMPATIBILITY) expect(decision.ok).toBe(false);
  });
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
