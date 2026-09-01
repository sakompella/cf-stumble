import { parseGenerationLabel } from "../../../src/supervisor/generations/index.js";
import {
  readyEpisode,
  recoveryEpisodeId,
  validateFailure,
  withEpisodeId,
} from "../../../src/supervisor/recovery/persistence/model.js";
import { advanceEpisode, settleRepair } from "../../../src/supervisor/recovery/operations.js";
import type { RecoveryPolicy } from "../../../src/supervisor/recovery/index.js";
import { expect, test } from "vitest";

const policy: RecoveryPolicy = {
  maxRepairAttempts: 1,
  recoveryBudgetMs: 100,
  operationDeadlineMs: 10,
};

function readyRecoveryEpisode() {
  const fallbackGenerationLabel = parseGenerationLabel(0);
  if (fallbackGenerationLabel === undefined) {
    throw new Error("zero must be a valid generation label");
  }

  return withEpisodeId(
    readyEpisode(
      validateFailure({ failureEventId: "advance-episode", failedGenerationLabel: 1 }),
      fallbackGenerationLabel,
      policy,
      100,
    ),
    recoveryEpisodeId(1),
  );
}

function openedRepair() {
  const advanced = advanceEpisode(readyRecoveryEpisode(), 100);
  if (advanced.episode.phase !== "repair-open") {
    throw new Error("a ready episode with remaining budget must open a repair");
  }
  return advanced.episode;
}

test("opens a repair for a ready episode with remaining budget", () => {
  expect(advanceEpisode(readyRecoveryEpisode(), 100)).toMatchObject({
    changed: true,
    episode: {
      phase: "repair-open",
      attemptsUsed: 1,
      currentOperation: { deadlineAt: 110, state: "open" },
    },
  });
});

test("prioritizes the recovery deadline over the repair-attempt budget", () => {
  const readyAfterFailedRepair = settleRepair(
    openedRepair(),
    { kind: "repair-failed", error: "failed" },
    101,
    0,
    true,
  );

  expect(advanceEpisode(readyAfterFailedRepair, 200)).toMatchObject({
    changed: true,
    episode: { phase: "completed", result: "fallback-retained:recovery-budget-exhausted" },
  });
});

test("prioritizes an operation deadline over both episode budgets", () => {
  expect(advanceEpisode(openedRepair(), 200)).toMatchObject({
    changed: true,
    episode: {
      phase: "needs-reconciliation",
      result: "operation-needs-reconciliation",
    },
  });
});
