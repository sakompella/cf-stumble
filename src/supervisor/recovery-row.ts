import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";
import { parseGenerationLabel, type GenerationLabel } from "./generations/index.js";
import {
  errorsFromText,
  recoveryEpisodeId,
  validateFailure,
  validateNow,
  validateRecoveryDeadline,
  validateRecoveryPolicy,
  type EpisodeRow,
} from "./recovery-model.js";
import { operationFromRow } from "./recovery-operation-row.js";
import { episodeForPhase } from "./recovery-row-phase.js";
import type { RecoveryEpisode, RecoveryEpisodeId, RecoveryOperation } from "./recovery-types.js";

export type DecodedRecoveryRow = {
  readonly row: EpisodeRow;
  readonly id: RecoveryEpisodeId;
  readonly fallbackGenerationLabel: GenerationLabel | undefined;
  readonly repairedHarnessCommit: HarnessCommit | undefined;
  readonly operation: RecoveryOperation | undefined;
  readonly base: EpisodeBase;
};

type EpisodeBase = {
  readonly id: RecoveryEpisodeId;
  readonly failure: ReturnType<typeof validateFailure>;
  readonly policy: {
    readonly maxRepairAttempts: number;
    readonly recoveryBudgetMs: number;
    readonly operationDeadlineMs: number;
  };
  readonly startedAt: number;
  readonly recoveryDeadlineAt: number;
  readonly attemptsUsed: number;
  readonly errors: readonly string[];
};

export function episodeFromRow(row: EpisodeRow): RecoveryEpisode {
  return episodeForPhase(decodeRow(row));
}

function decodeRow(row: EpisodeRow): DecodedRecoveryRow {
  const id = recoveryEpisodeId(row.id);
  const policy = {
    maxRepairAttempts: row.max_repair_attempts,
    recoveryBudgetMs: row.recovery_budget_ms,
    operationDeadlineMs: row.operation_deadline_ms,
  };
  validateRecoveryPolicy(policy);
  validateRowTiming(row, policy, id);
  return {
    row,
    id,
    fallbackGenerationLabel: nullableGenerationLabel(row.fallback_generation_label, id, "fallback"),
    repairedHarnessCommit: nullableHarnessCommit(row.repaired_harness_commit, id, "repaired"),
    operation: operationFromRow(row, id),
    base: {
      id,
      failure: validateFailure({
        failureEventId: row.failure_event_id,
        failedGenerationLabel: row.failed_generation_label,
      }),
      policy,
      startedAt: row.started_at,
      recoveryDeadlineAt: row.recovery_deadline_at,
      attemptsUsed: row.attempts_used,
      errors: errorsFromText(row.errors_text),
    },
  };
}

function validateRowTiming(
  row: EpisodeRow,
  policy: DecodedRecoveryRow["base"]["policy"],
  id: RecoveryEpisodeId,
): void {
  validateNow(row.started_at);
  validateNow(row.recovery_deadline_at);
  validateRecoveryDeadline(row.started_at, policy);
  if (row.recovery_deadline_at !== row.started_at + policy.recoveryBudgetMs) {
    throw invalidRow(id, "recovery deadline");
  }
  if (
    !Number.isSafeInteger(row.attempts_used) ||
    row.attempts_used < 0 ||
    row.attempts_used > policy.maxRepairAttempts
  ) {
    throw invalidRow(id, "attempt count");
  }
}

function nullableGenerationLabel(
  value: number | null,
  id: RecoveryEpisodeId,
  field: string,
): GenerationLabel | undefined {
  if (value === null) {
    return undefined;
  }
  const label = parseGenerationLabel(value);
  if (label === undefined) {
    throw invalidRow(id, `${field} generation label`);
  }
  return label;
}

function nullableHarnessCommit(
  value: string | null,
  id: RecoveryEpisodeId,
  field: string,
): HarnessCommit | undefined {
  if (value === null) {
    return undefined;
  }
  const harnessCommit = parseHarnessCommit(value);
  if (harnessCommit === undefined) {
    throw invalidRow(id, `${field} harness commit`);
  }
  return harnessCommit;
}

function invalidRow(id: RecoveryEpisodeId, field: string): Error {
  return new Error(`invalid persisted recovery ${id}: ${field}`);
}
