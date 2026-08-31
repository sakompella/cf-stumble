import { parseHarnessCommit } from "../harness-commit.js";
import { parseGenerationLabel } from "./generations/index.js";
import type { DecodedRecoveryRow } from "./recovery-row.js";
import type { RecoveryEpisode, RecoveryEpisodeId } from "./recovery-types.js";

export function episodeForPhase(context: DecodedRecoveryRow): RecoveryEpisode {
  switch (context.row.phase) {
    case "blocked":
      return blockedEpisode(context);
    case "ready":
      return readyEpisode(context);
    case "repair-open":
      return repairOpenEpisode(context);
    case "startup-check-open":
      return startupCheckOpenEpisode(context);
    case "needs-reconciliation":
      return reconciliationEpisode(context);
    case "completed":
      return completedEpisode(context);
    default:
      throw invalidRow(context.id, "phase");
  }
}

function blockedEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(row.result === "blocked:no-known-good-generation" &&
    fallbackGenerationLabel === undefined &&
    row.attempts_used === 0 &&
    repairedHarnessCommit === undefined &&
    operation === undefined &&
    hasNoVerifiedCandidate(row), context.id);
  return {
    ...base,
    fallbackGenerationLabel: undefined,
    repairedHarnessCommit: undefined,
    ...noVerifiedCandidate(),
    currentOperation: undefined,
    phase: "blocked",
    result: "blocked:no-known-good-generation",
  };
}

function readyEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(fallbackGenerationLabel !== undefined &&
    repairedHarnessCommit === undefined &&
    operation === undefined &&
    hasNoVerifiedCandidate(row) &&
    (row.result === "fallback-retained:repair-pending" ||
      row.result === "repair-failed" ||
      row.result === "startup-check-failed"), context.id);
  return {
    ...base,
    fallbackGenerationLabel,
    repairedHarnessCommit: undefined,
    ...noVerifiedCandidate(),
    currentOperation: undefined,
    phase: "ready",
    result: row.result,
  };
}

function repairOpenEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(fallbackGenerationLabel !== undefined &&
    repairedHarnessCommit === undefined &&
    operation?.kind === "repair" &&
    operation.state === "open" &&
    hasNoVerifiedCandidate(row) &&
    row.result === "repair-open", context.id);
  return {
    ...base,
    fallbackGenerationLabel,
    repairedHarnessCommit: undefined,
    ...noVerifiedCandidate(),
    currentOperation: operation,
    phase: "repair-open",
    result: "repair-open",
  };
}

function startupCheckOpenEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(fallbackGenerationLabel !== undefined &&
    repairedHarnessCommit !== undefined &&
    operation?.kind === "startup-check" &&
    operation.state === "open" &&
    hasNoVerifiedCandidate(row) &&
    row.result === "startup-check-open", context.id);
  return {
    ...base,
    fallbackGenerationLabel,
    repairedHarnessCommit,
    ...noVerifiedCandidate(),
    currentOperation: operation,
    phase: "startup-check-open",
    result: "startup-check-open",
  };
}

function reconciliationEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(fallbackGenerationLabel !== undefined &&
    operation?.state === "needs-reconciliation" &&
    row.result === "operation-needs-reconciliation" &&
    hasNoVerifiedCandidate(row), context.id);
  if (operation.kind === "repair" && repairedHarnessCommit === undefined) {
    return {
      ...base,
      fallbackGenerationLabel,
      repairedHarnessCommit: undefined,
      ...noVerifiedCandidate(),
      currentOperation: operation,
      phase: "needs-reconciliation",
      result: "operation-needs-reconciliation",
    };
  }
  if (operation.kind === "startup-check" && repairedHarnessCommit !== undefined) {
    return {
      ...base,
      fallbackGenerationLabel,
      repairedHarnessCommit,
      ...noVerifiedCandidate(),
      currentOperation: operation,
      phase: "needs-reconciliation",
      result: "operation-needs-reconciliation",
    };
  }
  throw invalidRow(context.id, "reconciliation operation");
}

function completedEpisode(context: DecodedRecoveryRow): RecoveryEpisode {
  const { row, fallbackGenerationLabel, repairedHarnessCommit, operation, base } = context;
  require(fallbackGenerationLabel !== undefined &&
    repairedHarnessCommit === undefined &&
    operation === undefined, context.id);
  if (
    row.result === "fallback-retained:repair-attempt-budget-exhausted" ||
    row.result === "fallback-retained:recovery-budget-exhausted"
  ) {
    require(hasNoVerifiedCandidate(row), context.id);
    return {
      ...base,
      fallbackGenerationLabel,
      repairedHarnessCommit: undefined,
      ...noVerifiedCandidate(),
      currentOperation: undefined,
      phase: "completed",
      result: row.result,
    };
  }
  require(row.result === "fallback-retained:repaired-generation-verified", context.id);
  return {
    ...base,
    fallbackGenerationLabel,
    repairedHarnessCommit: undefined,
    ...verifiedCandidate(row, context.id),
    currentOperation: undefined,
    phase: "completed",
    result: "fallback-retained:repaired-generation-verified",
  };
}

function hasNoVerifiedCandidate(row: DecodedRecoveryRow["row"]): boolean {
  return (
    row.verified_harness_commit === null &&
    row.verified_generation_label === null &&
    row.verified_preparation_check_id === null
  );
}

function noVerifiedCandidate() {
  return {
    verifiedHarnessCommit: undefined,
    verifiedGenerationLabel: undefined,
    verifiedPreparationCheckId: undefined,
  } as const;
}

function verifiedCandidate(row: DecodedRecoveryRow["row"], id: RecoveryEpisodeId) {
  if (
    row.verified_harness_commit === null ||
    row.verified_generation_label === null ||
    row.verified_preparation_check_id === null ||
    !Number.isSafeInteger(row.verified_preparation_check_id) ||
    row.verified_preparation_check_id < 1
  ) {
    throw invalidRow(id, "verified candidate");
  }
  const harnessCommit = parseHarnessCommit(row.verified_harness_commit);
  const generationLabel = parseGenerationLabel(row.verified_generation_label);
  if (harnessCommit === undefined || generationLabel === undefined) {
    throw invalidRow(id, "verified candidate");
  }
  return {
    verifiedHarnessCommit: harnessCommit,
    verifiedGenerationLabel: generationLabel,
    verifiedPreparationCheckId: row.verified_preparation_check_id,
  } as const;
}

function require(condition: boolean, id: RecoveryEpisodeId): asserts condition {
  if (!condition) {
    throw invalidRow(id, "state");
  }
}

function invalidRow(id: RecoveryEpisodeId, field: string): Error {
  return new Error(`invalid persisted recovery ${id}: ${field}`);
}
