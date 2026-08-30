import { DEFAULT_ELIGIBILITY_POLICY, deriveGenerationEligibility } from "./eligibility.js";
import type { EligibilityPolicy } from "./eligibility.js";
import type { Generations } from "./generations.js";
import type { RelayFacts } from "./relay-facts.js";
import {
  blockedEpisode,
  complete,
  episodeFromRow,
  episodeSelect,
  errorsToText,
  readyEpisode,
  recoverySchema,
  settleOperation,
  validateEpisodeId,
  validateFailure,
  validateNow,
  validateOutcome,
  validateRecoveryDeadline,
  validateRecoveryPolicy,
} from "./recovery-model.js";
import type { EpisodeRow } from "./recovery-model.js";
import type {
  RecoveryEpisode,
  RecoveryFailure,
  RecoveryOperation,
  RecoveryOperationReport,
  RecoveryPolicy,
  RepairOperationOutcome,
} from "./recovery-types.js";

export type {
  RecoveryEpisode,
  RecoveryFailure,
  RecoveryOperation,
  RecoveryOperationReport,
  RecoveryPolicy,
  RepairOperationOutcome,
} from "./recovery-types.js";
export { validateRecoveryPolicy } from "./recovery-model.js";

export class Recovery {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly generations: Generations;
  private readonly relayFacts: RelayFacts;

  constructor(storage: DurableObjectStorage, generations: Generations, relayFacts: RelayFacts) {
    this.storage = storage;
    this.sql = storage.sql;
    this.generations = generations;
    this.relayFacts = relayFacts;
    this.sql.exec(recoverySchema);
  }

  start(
    failure: RecoveryFailure,
    policy: RecoveryPolicy,
    now: number,
    eligibilityPolicy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
  ): RecoveryEpisode {
    validateFailure(failure);
    validateNow(now);
    return this.storage.transactionSync(() => {
      const existing = this.byFailureEventId(failure.failureEventId);
      if (existing !== undefined) {
        return existing;
      }

      validateRecoveryPolicy(policy);
      validateRecoveryDeadline(now, policy);
      const fallbackGenerationLabel = this.chooseFallback(
        failure.failedGenerationLabel,
        eligibilityPolicy,
      );
      const episode =
        fallbackGenerationLabel === undefined
          ? blockedEpisode(failure, policy, now)
          : readyEpisode(failure, fallbackGenerationLabel, policy, now);
      this.insert(episode);
      return {
        ...episode,
        id: this.sql.exec<{ readonly id: number }>("SELECT last_insert_rowid() AS id").one().id,
      };
    });
  }

  resume(id: number, now: number): RecoveryEpisode {
    validateEpisodeId(id);
    validateNow(now);
    return this.storage.transactionSync(() => this.advance(this.requiredById(id), now));
  }

  reportOperation(
    id: number,
    key: string,
    outcome: RepairOperationOutcome,
    now: number,
  ): RecoveryOperationReport {
    validateEpisodeId(id);
    validateNow(now);
    validateOutcome(outcome);
    return this.storage.transactionSync(() => {
      const episode = this.requiredById(id);
      const operation = episode.currentOperation;
      if (operation?.state === "open" && now >= operation.deadlineAt) {
        return { applied: false, episode: this.advance(episode, now) };
      }

      if (operation === undefined || operation.key !== key || operation.state !== "open") {
        return { applied: false, episode };
      }

      const settled = settleOperation(episode, outcome);
      this.store(settled);
      return { applied: true, episode: settled };
    });
  }

  reconcileOperation(
    id: number,
    key: string,
    outcome: RepairOperationOutcome,
    now: number,
  ): RecoveryOperationReport {
    validateEpisodeId(id);
    validateNow(now);
    validateOutcome(outcome);
    return this.storage.transactionSync(() => {
      const episode = this.requiredById(id);
      const operation = episode.currentOperation;
      if (
        operation === undefined ||
        operation.key !== key ||
        operation.state !== "needs-reconciliation"
      ) {
        return { applied: false, episode };
      }

      const settled = settleOperation(episode, outcome);
      this.store(settled);
      return { applied: true, episode: settled };
    });
  }

  get(id: number): RecoveryEpisode | undefined {
    return Number.isSafeInteger(id) && id > 0 ? this.byId(id) : undefined;
  }

  private advance(episode: RecoveryEpisode, now: number): RecoveryEpisode {
    if (episode.phase === "blocked" || episode.phase === "completed") {
      return episode;
    }

    if (now >= episode.recoveryDeadlineAt) {
      const exhausted = complete(episode, "fallback-retained:recovery-budget-exhausted");
      this.store(exhausted);
      return exhausted;
    }

    const operation = episode.currentOperation;
    if (operation !== undefined) {
      return this.advanceOperation(episode, operation, now);
    }

    if (episode.attemptsUsed >= episode.policy.maxRepairAttempts) {
      const exhausted = complete(episode, "fallback-retained:repair-attempt-budget-exhausted");
      this.store(exhausted);
      return exhausted;
    }

    const attempt = episode.attemptsUsed + 1;
    const opened = {
      ...episode,
      attemptsUsed: attempt,
      phase: "repair-open" as const,
      result: "repair-open",
      currentOperation: {
        kind: "repair" as const,
        attempt,
        key: `recovery-${episode.id}:repair:${attempt}`,
        deadlineAt: Math.min(now + episode.policy.operationDeadlineMs, episode.recoveryDeadlineAt),
        state: "open" as const,
      },
    };
    this.store(opened);
    return opened;
  }

  private advanceOperation(
    episode: RecoveryEpisode,
    operation: RecoveryOperation,
    now: number,
  ): RecoveryEpisode {
    if (operation.state !== "open" || now < operation.deadlineAt) {
      return episode;
    }

    const expired = {
      ...episode,
      phase: "needs-reconciliation" as const,
      result: "operation-needs-reconciliation",
      errors: [...episode.errors, "operation-deadline-exceeded"],
      currentOperation: { ...operation, state: "needs-reconciliation" as const },
    };
    this.store(expired);
    return expired;
  }

  private chooseFallback(
    failedGenerationLabel: number,
    policy: EligibilityPolicy,
  ): number | undefined {
    const attempts = this.relayFacts.attempts();
    return this.generations
      .all()
      .toReversed()
      .find(
        (generation) =>
          generation.label !== failedGenerationLabel &&
          deriveGenerationEligibility(
            {
              generationLabel: generation.label,
              latestActivationId: this.generations.latestActivationId(generation.label),
              latestPreparationCheck: this.generations.latestPreparationCheck(generation.label),
              attempts,
            },
            policy,
          ).kind === "eligible",
      )?.label;
  }

  private byFailureEventId(failureEventId: string): RecoveryEpisode | undefined {
    const row = this.sql
      .exec<EpisodeRow>(`${episodeSelect} WHERE failure_event_id = ?`, failureEventId)
      .toArray()[0];
    return row === undefined ? undefined : episodeFromRow(row);
  }

  private byId(id: number): RecoveryEpisode | undefined {
    const row = this.sql.exec<EpisodeRow>(`${episodeSelect} WHERE id = ?`, id).toArray()[0];
    return row === undefined ? undefined : episodeFromRow(row);
  }

  private requiredById(id: number): RecoveryEpisode {
    const episode = this.byId(id);
    if (episode === undefined) {
      throw new Error(`unknown recovery: ${id}`);
    }

    return episode;
  }

  private insert(episode: RecoveryEpisode): void {
    this.sql.exec(
      `INSERT INTO recovery_episodes (
         failure_event_id, failed_generation_label, fallback_generation_label, max_repair_attempts,
         recovery_budget_ms, operation_deadline_ms, started_at, recovery_deadline_at, attempts_used,
         phase, result, errors_text, operation_key, operation_attempt, operation_deadline_at,
         operation_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      episode.failure.failureEventId,
      episode.failure.failedGenerationLabel,
      episode.fallbackGenerationLabel ?? null,
      episode.policy.maxRepairAttempts,
      episode.policy.recoveryBudgetMs,
      episode.policy.operationDeadlineMs,
      episode.startedAt,
      episode.recoveryDeadlineAt,
      episode.attemptsUsed,
      episode.phase,
      episode.result,
      errorsToText(episode.errors),
      episode.currentOperation?.key ?? null,
      episode.currentOperation?.attempt ?? null,
      episode.currentOperation?.deadlineAt ?? null,
      episode.currentOperation?.state ?? null,
    );
  }

  private store(episode: RecoveryEpisode): void {
    this.sql.exec(
      `UPDATE recovery_episodes
       SET attempts_used = ?, phase = ?, result = ?, errors_text = ?, operation_key = ?,
           operation_attempt = ?, operation_deadline_at = ?, operation_state = ?
       WHERE id = ?`,
      episode.attemptsUsed,
      episode.phase,
      episode.result,
      errorsToText(episode.errors),
      episode.currentOperation?.key ?? null,
      episode.currentOperation?.attempt ?? null,
      episode.currentOperation?.deadlineAt ?? null,
      episode.currentOperation?.state ?? null,
      episode.id,
    );
  }
}
