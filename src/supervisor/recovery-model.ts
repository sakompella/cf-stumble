import { parseHarnessCommit } from "../harness-commit.js";
import { parseGenerationLabel, type GenerationLabel } from "./generation-types.js";
import type {
  RecoveryEpisodeDraft,
  RecoveryEpisodeId,
  RecoveryFailure,
  RecoveryFailureInput,
  RecoveryOperationOutcome,
  RecoveryOperationOutcomeInput,
  RecoveryPolicy,
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
  readonly repaired_harness_commit: string | null;
  readonly verified_harness_commit: string | null;
  readonly verified_generation_label: number | null;
  readonly verified_preparation_check_id: number | null;
  readonly operation_kind: string | null;
  readonly operation_key: string | null;
  readonly operation_attempt: number | null;
  readonly operation_deadline_at: number | null;
  readonly operation_state: string | null;
  readonly preparation_check_id_at_open: number | null;
};

export const recoverySchema = `
  CREATE TABLE IF NOT EXISTS recovery_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
    failure_event_id TEXT NOT NULL UNIQUE,
    failed_generation_label INTEGER NOT NULL CHECK (failed_generation_label >= 0),
    fallback_generation_label INTEGER CHECK (fallback_generation_label >= 0),
    max_repair_attempts INTEGER NOT NULL CHECK (max_repair_attempts > 0),
    recovery_budget_ms INTEGER NOT NULL CHECK (recovery_budget_ms > 0),
    operation_deadline_ms INTEGER NOT NULL CHECK (
      operation_deadline_ms > 0 AND operation_deadline_ms <= recovery_budget_ms
    ),
    started_at INTEGER NOT NULL,
    recovery_deadline_at INTEGER NOT NULL CHECK (
      recovery_deadline_at = started_at + recovery_budget_ms
    ),
    attempts_used INTEGER NOT NULL CHECK (
      attempts_used >= 0 AND attempts_used <= max_repair_attempts
    ),
    phase TEXT NOT NULL CHECK (phase IN (
      'blocked', 'ready', 'repair-open', 'startup-check-open', 'needs-reconciliation', 'completed'
    )),
    result TEXT NOT NULL,
    errors_text TEXT NOT NULL,
    repaired_harness_commit TEXT,
    verified_harness_commit TEXT,
    verified_generation_label INTEGER CHECK (verified_generation_label >= 0),
    verified_preparation_check_id INTEGER CHECK (verified_preparation_check_id > 0),
    operation_kind TEXT CHECK (operation_kind IN ('repair', 'startup-check')),
    operation_key TEXT,
    operation_attempt INTEGER CHECK (operation_attempt > 0),
    operation_deadline_at INTEGER,
    operation_state TEXT CHECK (operation_state IN ('open', 'needs-reconciliation')),
    preparation_check_id_at_open INTEGER CHECK (preparation_check_id_at_open >= 0),
    CHECK (
      operation_deadline_at IS NULL OR (
        operation_deadline_at >= started_at AND operation_deadline_at <= recovery_deadline_at
      )
    ),
    CHECK (
      (phase = 'blocked' AND fallback_generation_label IS NULL AND attempts_used = 0 AND
       result = 'blocked:no-known-good-generation' AND repaired_harness_commit IS NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND operation_kind IS NULL AND operation_key IS NULL AND
       operation_attempt IS NULL AND operation_deadline_at IS NULL AND operation_state IS NULL AND
       preparation_check_id_at_open IS NULL)
      OR
      (phase = 'ready' AND fallback_generation_label IS NOT NULL AND repaired_harness_commit IS NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND result IN (
         'fallback-retained:repair-pending', 'repair-failed', 'startup-check-failed'
       ) AND operation_kind IS NULL AND operation_key IS NULL AND operation_attempt IS NULL AND
       operation_deadline_at IS NULL AND operation_state IS NULL AND preparation_check_id_at_open IS NULL)
      OR
      (phase = 'repair-open' AND fallback_generation_label IS NOT NULL AND repaired_harness_commit IS NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND result = 'repair-open' AND operation_kind = 'repair' AND
       operation_key = 'recovery-' || id || ':repair:' || operation_attempt AND operation_attempt <= attempts_used AND
       operation_deadline_at IS NOT NULL AND operation_state = 'open' AND preparation_check_id_at_open IS NULL)
      OR
      (phase = 'startup-check-open' AND fallback_generation_label IS NOT NULL AND repaired_harness_commit IS NOT NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND result = 'startup-check-open' AND
       operation_kind = 'startup-check' AND operation_key = 'recovery-' || id || ':startup-check:' || operation_attempt AND
       operation_attempt <= attempts_used AND operation_deadline_at IS NOT NULL AND operation_state = 'open' AND
       preparation_check_id_at_open IS NOT NULL)
      OR
      (phase = 'needs-reconciliation' AND fallback_generation_label IS NOT NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND result = 'operation-needs-reconciliation' AND
       operation_kind = 'repair' AND repaired_harness_commit IS NULL AND
       operation_key = 'recovery-' || id || ':repair:' || operation_attempt AND operation_attempt <= attempts_used AND
       operation_deadline_at IS NOT NULL AND operation_state = 'needs-reconciliation' AND
       preparation_check_id_at_open IS NULL)
      OR
      (phase = 'needs-reconciliation' AND fallback_generation_label IS NOT NULL AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND result = 'operation-needs-reconciliation' AND
       operation_kind = 'startup-check' AND repaired_harness_commit IS NOT NULL AND
       operation_key = 'recovery-' || id || ':startup-check:' || operation_attempt AND operation_attempt <= attempts_used AND
       operation_deadline_at IS NOT NULL AND operation_state = 'needs-reconciliation' AND
       preparation_check_id_at_open IS NOT NULL)
      OR
      (phase = 'completed' AND fallback_generation_label IS NOT NULL AND repaired_harness_commit IS NULL AND
       result IN ('fallback-retained:repair-attempt-budget-exhausted', 'fallback-retained:recovery-budget-exhausted') AND
       verified_harness_commit IS NULL AND verified_generation_label IS NULL AND
       verified_preparation_check_id IS NULL AND operation_kind IS NULL AND operation_key IS NULL AND
       operation_attempt IS NULL AND operation_deadline_at IS NULL AND operation_state IS NULL AND
       preparation_check_id_at_open IS NULL)
      OR
      (phase = 'completed' AND fallback_generation_label IS NOT NULL AND repaired_harness_commit IS NULL AND
       result = 'fallback-retained:repaired-generation-verified' AND verified_harness_commit IS NOT NULL AND
       verified_generation_label IS NOT NULL AND verified_preparation_check_id IS NOT NULL AND
       operation_kind IS NULL AND operation_key IS NULL AND operation_attempt IS NULL AND
       operation_deadline_at IS NULL AND operation_state IS NULL AND preparation_check_id_at_open IS NULL)
    )
  );
`;

export const episodeSelect = `SELECT id, failure_event_id, failed_generation_label,
  fallback_generation_label, max_repair_attempts, recovery_budget_ms, operation_deadline_ms,
  started_at, recovery_deadline_at, attempts_used, phase, result, errors_text,
  repaired_harness_commit, verified_harness_commit, verified_generation_label,
  verified_preparation_check_id, operation_kind, operation_key, operation_attempt,
  operation_deadline_at, operation_state, preparation_check_id_at_open FROM recovery_episodes`;

export { episodeFromRow } from "./recovery-row.js";

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
): RecoveryEpisodeDraft {
  return episodeDraft(failure, policy, now);
}

export function readyEpisode(
  failure: RecoveryFailure,
  fallbackGenerationLabel: GenerationLabel,
  policy: RecoveryPolicy,
  now: number,
): RecoveryEpisodeDraft {
  return episodeDraft(failure, policy, now, fallbackGenerationLabel);
}

export function withEpisodeId<T extends RecoveryEpisodeDraft>(
  draft: T,
  id: RecoveryEpisodeId,
): T & { readonly id: RecoveryEpisodeId } {
  return { ...draft, id };
}

export function errorsToText(errors: readonly string[]): string {
  return errors.map((error) => encodeURIComponent(error)).join("|");
}

export function errorsFromText(encoded: string): readonly string[] {
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

export function parseRecoveryOperationOutcome(
  outcome: RecoveryOperationOutcomeInput,
): RecoveryOperationOutcome | undefined {
  switch (outcome.kind) {
    case "repair-succeeded": {
      const repairedHarnessCommit = parseHarnessCommit(outcome.repairedHarnessCommit);
      return repairedHarnessCommit === undefined
        ? undefined
        : { ...outcome, repairedHarnessCommit };
    }
    case "repair-failed":
    case "startup-check-failed":
      return outcome.error.length === 0 ? undefined : outcome;
    case "startup-check-passed": {
      const generationLabel = parseGenerationLabel(outcome.generationLabel);
      return generationLabel === undefined ? undefined : { ...outcome, generationLabel };
    }
    default:
      return undefined;
  }
}

export function recoveryEpisodeId(value: number): RecoveryEpisodeId {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("recovery id must be a positive safe integer");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the guard accepts only positive safe integer recovery episode IDs.
  return value as RecoveryEpisodeId;
}

export function validateEpisodeId(id: number): void {
  recoveryEpisodeId(id);
}

export function validateNow(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new TypeError("now must be a safe integer");
  }
}

export function validateRecoveryDeadline(now: number, policy: RecoveryPolicy): void {
  if (now > Number.MAX_SAFE_INTEGER - policy.recoveryBudgetMs) {
    throw new RangeError("recovery deadline must be a safe integer");
  }
}

function episodeDraft(
  failure: RecoveryFailure,
  policy: RecoveryPolicy,
  now: number,
  fallbackGenerationLabel?: GenerationLabel,
): RecoveryEpisodeDraft {
  const base = {
    failure,
    policy,
    startedAt: now,
    recoveryDeadlineAt: now + policy.recoveryBudgetMs,
    attemptsUsed: 0,
    errors: [],
    repairedHarnessCommit: undefined,
    verifiedHarnessCommit: undefined,
    verifiedGenerationLabel: undefined,
    verifiedPreparationCheckId: undefined,
    currentOperation: undefined,
  } as const;
  return fallbackGenerationLabel === undefined
    ? {
        ...base,
        fallbackGenerationLabel,
        phase: "blocked",
        result: "blocked:no-known-good-generation",
      }
    : {
        ...base,
        fallbackGenerationLabel,
        phase: "ready",
        result: "fallback-retained:repair-pending",
      };
}
