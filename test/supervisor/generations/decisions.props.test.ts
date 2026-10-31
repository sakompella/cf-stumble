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

const SUPERVISOR_VERSION = "1.4.0";

const count = gs.integers({ minValue: 0, maxValue: 2 ** 40 });

const labelValue = gs.integers({ minValue: 0, maxValue: 2 ** 39 });

const kind = gs.sampledFrom(["activate", "rollback"] as const);

const recordedVersion = gs.sampledFrom([SUPERVISOR_VERSION, "1.3.9", undefined] as const);

test("only the current epoch can change the selection, whatever the target", () => {
  hegel.test((tc) => {
    const epoch = tc.draw(count);
    const observedEpoch = tc.draw(count);
    const target = tc.draw(labelValue);
    const status = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));

    const record = {
      generation: generation(target, status),
      wasActive: tc.draw(gs.booleans()),
      piDurableVersion: tc.draw(recordedVersion),
    };

    const command = { kind: tc.draw(kind), label: label(target), observedEpoch };

    const decision = decideActivation(
      command,
      record,
      { activeLabel: undefined, epoch },
      SUPERVISOR_VERSION,
    );

    if (observedEpoch !== epoch) {
      expect(decision).toEqual({ ok: false, problem: { code: "stale-epoch" } });
    }

    if (status !== "ready") expect(decision.ok).toBe(false);

    if (record.piDurableVersion !== SUPERVISOR_VERSION) expect(decision.ok).toBe(false);
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
      { generation: ready, wasActive: true, piDurableVersion: SUPERVISOR_VERSION },
      { activeLabel, epoch },
      SUPERVISOR_VERSION,
    );

    expect(decision).toMatchObject(
      active === "same"
        ? { ok: true, outcome: { generation: ready, epoch, effect: "no-op" } }
        : { ok: true, outcome: { generation: ready, epoch: epoch + 1, effect: "activated" } },
    );
  });
});

test("a check records the outcome's status and version, advances the epoch by one, and is a no-op only when nothing changed", () => {
  hegel.test((tc) => {
    const target = tc.draw(labelValue);
    const epoch = tc.draw(count);
    const previousStatus = tc.draw(gs.sampledFrom(["candidate", "ready", "failed"] as const));
    const previousVersion = tc.draw(recordedVersion);
    const checkedVersion = tc.draw(recordedVersion);
    const wasActive = tc.draw(gs.booleans());

    const outcome =
      checkedVersion === undefined
        ? ({ status: "failed" } as const)
        : ({ status: "ready", piDurableVersion: checkedVersion } as const);

    const previous = {
      generation: generation(target, previousStatus),
      wasActive,
      piDurableVersion: previousVersion,
    };

    expect(decidePreparation(previous, outcome, { activeLabel: undefined, epoch })).toEqual({
      record: {
        generation: generation(target, outcome.status),
        wasActive,
        piDurableVersion: checkedVersion,
      },
      epoch: epoch + 1,
      effect:
        previousStatus === outcome.status && previousVersion === checkedVersion
          ? "no-op"
          : "recorded",
    });
  });
});
