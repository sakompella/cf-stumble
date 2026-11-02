import { expect, test } from "vitest";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { decidePreparation, type GenerationRecord } from "../../../src/supervisor/generations.js";
import { label } from "./fixtures.js";

const COMPATIBILITY = "pi-durable@1.4.0/host-2";

const confirmed: GenerationRecord = {
  generation: {
    label: label(1),
    harnessCommit: testHarnessCommit("a".repeat(40)),
    status: "ready",
  },
  wasActive: false,
  compatibility: COMPATIBILITY,
};

test("a check confirming the recorded status and compatibility is a no-op that keeps the epoch", () => {
  const decided = decidePreparation(
    confirmed,
    { status: "ready", compatibility: COMPATIBILITY },
    { activeLabel: undefined, epoch: 5 },
  );

  expect(decided).toEqual({ record: confirmed, epoch: 5, effect: "no-op" });
});
