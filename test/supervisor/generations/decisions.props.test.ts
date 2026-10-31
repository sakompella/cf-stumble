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

const count = gs.integers({ minValue: 0, maxValue: 2 ** 40 });

const labelValue = gs.integers({ minValue: 0, maxValue: 2 ** 39 });

const kind = gs.sampledFrom(["activate", "rollback"] as const);

test("only the current epoch can change the selection, whatever the target", () => {
  hegel.test((tc) => {
    const epoch = tc.draw(count);
    const observedEpoch = tc.draw(count);
    const target = tc.draw(labelValue);
    const status = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));
    const record = { generation: generation(target, status), wasActive: tc.draw(gs.booleans()) };
    const command = { kind: tc.draw(kind), label: label(target), observedEpoch };

    const decision = decideActivation(command, record, { activeLabel: undefined, epoch });

    if (observedEpoch !== epoch) {
      expect(decision).toEqual({ ok: false, problem: { code: "stale-epoch" } });
    }

    if (status !== "ready") expect(decision.ok).toBe(false);
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
      { generation: ready, wasActive: true },
      {
        activeLabel,
        epoch,
      },
    );

    expect(decision).toMatchObject(
      active === "same"
        ? { ok: true, outcome: { generation: ready, epoch, effect: "no-op" } }
        : { ok: true, outcome: { generation: ready, epoch: epoch + 1, effect: "activated" } },
    );
  });
});

test("a check records the outcome's status, advances the epoch by one, and is a no-op only when nothing changed", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const outcome = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
    const previous = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));
    const status: GenerationStatus = outcome === "passed" ? "ready" : "failed";

    expect(
      decidePreparation(generation(target, previous), outcome, { activeLabel: undefined, epoch }),
    ).toEqual({
      generation: generation(target, status),
      epoch: epoch + 1,
      effect: previous === status ? "no-op" : "recorded",
    });
  });
});
