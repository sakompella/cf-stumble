import { parseGenerationLabel, type GenerationLabel } from "./generation-types.js";
import type {
  RecoveryEpisode,
  RecoveryFailure,
  RecoveryFailureInput,
  RecoveryOperation,
  RecoveryPhase,
  RecoveryPolicy,
  RepairOperationOutcome,
} from "./recovery-types.js";

export type EpisodeRow = {
  readonly id: number;
  readonly failure_event_id: string;
  readonly failed_generation_label: number;
  readonly fallback_generation_label: number | null;
  readonly max_repair_attempts: number;
  readonly recovery_budget_ms: number;
  readonly operation_deadline_ms: number;
  readonly started_at: number;
  readonly recovery_deadline_at: number;
  readonly attempts_used: number;
  readonly phase: string;
  readonly result: string;
  readonly errors_text: string;
  readonly operation_key: string | null;
  readonly operation_attempt: number | null;
  readonly operation_deadline_at: number | null;
  readonly operation_state: string | null;
};

export const recoverySchema = `
  CREATE TABLE IF NOT EXISTS recovery_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    failure_event_id TEXT NOT NULL UNIQUE,
    failed_generation_label INTEGER NOT NULL,
    fallback_generation_label INTEGER,
    max_repair_attempts INTEGER NOT NULL,
    recovery_budget_ms INTEGER NOT NULL,
    operation_deadline_ms INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    recovery_deadline_at INTEGER NOT NULL,
    attempts_used INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN (
      'blocked', 'ready', 'repair-open', 'needs-reconciliation', 'completed'
    )),
    result TEXT NOT NULL,
    errors_text TEXT NOT NULL,
    operation_key TEXT,
    operation_attempt INTEGER,
    operation_deadline_at INTEGER,
    operation_state TEXT CHECK (operation_state IN ('open', 'needs-reconciliation'))
  );
`;

export const episodeSelect = `SELECT id, failure_event_id, failed_generation_label, fallback_generation_label,
  max_repair_attempts, recovery_budget_ms, operation_deadline_ms, started_at, recovery_deadline_at,
  attempts_used, phase, result, errors_text, operation_key, operation_attempt, operation_deadline_at,
  operation_state FROM recovery_episodes`;

export function validateRecoveryPolicy(policy: RecoveryPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }

  if (policy.operationDeadlineMs > policy.recoveryBudgetMs) {
    throw new Error("operationDeadlineMs cannot exceed recoveryBudgetMs");
  }
}

export function blockedEpisode(
  failure: RecoveryFailure,
  policy: RecoveryPolicy,
  now: number,
): RecoveryEpisode {
  return {
    id: 0,
    failure,
    fallbackGenerationLabel: undefined,
    policy,
    startedAt: now,
    recoveryDeadlineAt: now + policy.recoveryBudgetMs,
    attemptsUsed: 0,
    phase: "blocked",
    result: "blocked:no-known-good-generation",
    errors: [],
    currentOperation: undefined,
  };
}

export function readyEpisode(
  failure: RecoveryFailure,
  fallbackGenerationLabel: GenerationLabel,
  policy: RecoveryPolicy,
  now: number,
): RecoveryEpisode {
  return {
    id: 0,
    failure,
    fallbackGenerationLabel,
    policy,
    startedAt: now,
    recoveryDeadlineAt: now + policy.recoveryBudgetMs,
    attemptsUsed: 0,
    phase: "ready",
    result: "fallback-retained:repair-pending",
    errors: [],
    currentOperation: undefined,
  };
}

export function complete(episode: RecoveryEpisode, result: string): RecoveryEpisode {
  return { ...episode, phase: "completed", result, currentOperation: undefined };
}

export function settleOperation(
  episode: RecoveryEpisode,
  outcome: RepairOperationOutcome,
): RecoveryEpisode {
  if (outcome.kind === "succeeded") {
    return complete(episode, "fallback-retained:repair-succeeded-without-materialized-generation");
  }

  return {
    ...episode,
    phase: "ready",
    result: "repair-failed",
    errors: [...episode.errors, outcome.error],
    currentOperation: undefined,
  };
}

export function episodeFromRow(row: EpisodeRow): RecoveryEpisode {
  const failedGenerationLabel = generationLabelFromRow(row.failed_generation_label, row.id);
  const fallbackGenerationLabel = nullableGenerationLabelFromRow(
    row.fallback_generation_label,
    row.id,
  );
  const phase = recoveryPhaseFromRow(row.phase, row.id);

  return {
    id: row.id,
    failure: {
      failureEventId: row.failure_event_id,
      failedGenerationLabel,
    },
    fallbackGenerationLabel,
    policy: {
      maxRepairAttempts: row.max_repair_attempts,
      recoveryBudgetMs: row.recovery_budget_ms,
      operationDeadlineMs: row.operation_deadline_ms,
    },
    startedAt: row.started_at,
    recoveryDeadlineAt: row.recovery_deadline_at,
    attemptsUsed: row.attempts_used,
    phase,
    result: row.result,
    errors: errorsFromText(row.errors_text),
    currentOperation: operationFromRow(row),
  };
}

function operationFromRow(row: EpisodeRow): RecoveryOperation | undefined {
  if (
    row.operation_key === null &&
    row.operation_attempt === null &&
    row.operation_deadline_at === null &&
    row.operation_state === null
  ) {
    return undefined;
  }

  if (
    row.operation_key !== null &&
    row.operation_attempt !== null &&
    row.operation_deadline_at !== null &&
    row.operation_state !== null
  ) {
    return {
      kind: "repair",
      key: row.operation_key,
      attempt: row.operation_attempt,
      deadlineAt: row.operation_deadline_at,
      state: recoveryOperationStateFromRow(row.operation_state, row.id),
    };
  }

  throw new Error(`invalid recovery operation ${row.id}`);
}

export function errorsToText(errors: readonly string[]): string {
  return errors.map((error) => encodeURIComponent(error)).join("|");
}

function errorsFromText(encoded: string): readonly string[] {
  return encoded.length === 0 ? [] : encoded.split("|").map((error) => decodeURIComponent(error));
}

export function validateFailure(failure: RecoveryFailureInput): RecoveryFailure {
  if (failure.failureEventId.length === 0) {
    throw new Error("failureEventId must not be empty");
  }

  const failedGenerationLabel = parseGenerationLabel(failure.failedGenerationLabel);
  if (failedGenerationLabel === undefined) {
    throw new TypeError("failedGenerationLabel must be a non-negative safe integer");
  }

  return { failureEventId: failure.failureEventId, failedGenerationLabel };
}

function recoveryPhaseFromRow(value: string, episodeId: number): RecoveryPhase {
  if (
    value === "blocked" ||
    value === "ready" ||
    value === "repair-open" ||
    value === "needs-reconciliation" ||
    value === "completed"
  ) {
    return value;
  }

  throw new Error(`invalid persisted recovery phase for ${episodeId}`);
}

function recoveryOperationStateFromRow(
  value: string,
  episodeId: number,
): RecoveryOperation["state"] {
  if (value === "open" || value === "needs-reconciliation") {
    return value;
  }

  throw new Error(`invalid persisted recovery operation state for ${episodeId}`);
}

function generationLabelFromRow(value: number, episodeId: number): GenerationLabel {
  const generationLabel = parseGenerationLabel(value);
  if (generationLabel === undefined) {
    throw new Error(`invalid persisted failed generation label for recovery ${episodeId}`);
  }

  return generationLabel;
}

function nullableGenerationLabelFromRow(
  value: number | null,
  episodeId: number,
): GenerationLabel | undefined {
  if (value === null) {
    return undefined;
  }

  const generationLabel = parseGenerationLabel(value);
  if (generationLabel === undefined) {
    throw new Error(`invalid persisted fallback generation label for recovery ${episodeId}`);
  }

  return generationLabel;
}

export function validateRecoveryDeadline(now: number, policy: RecoveryPolicy): void {
  if (now > Number.MAX_SAFE_INTEGER - policy.recoveryBudgetMs) {
    throw new RangeError("recovery deadline must be a safe integer");
  }
}

export function validateEpisodeId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError("recovery id must be a positive safe integer");
  }
}

export function validateNow(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new TypeError("now must be a safe integer");
  }
}

export function validateOutcome(outcome: RepairOperationOutcome): void {
  if (outcome.kind === "failed" && outcome.error.length === 0) {
    throw new TypeError("failed repair outcomes need an error");
  }
}
