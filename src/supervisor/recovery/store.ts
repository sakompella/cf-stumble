import { episodeFromRow } from "./persistence/row.js";
import {
  episodeSelect,
  errorsToText,
  recoveryEpisodeId,
  recoverySchema,
  type EpisodeRow,
} from "./persistence/model.js";
import type { RecoveryEpisode, RecoveryEpisodeDraft, RecoveryEpisodeId } from "./episode.js";

export class RecoveryEpisodeStore {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(recoverySchema);
  }

  byFailureEventId(failureEventId: string): RecoveryEpisode | undefined {
    const row = this.sql
      .exec<EpisodeRow>(`${episodeSelect} WHERE failure_event_id = ?`, failureEventId)
      .toArray()[0];
    return row === undefined ? undefined : episodeFromRow(row);
  }

  byId(id: number): RecoveryEpisode | undefined {
    const row = this.sql.exec<EpisodeRow>(`${episodeSelect} WHERE id = ?`, id).toArray()[0];
    return row === undefined ? undefined : episodeFromRow(row);
  }

  /** The last episode this Supervisor opened. Episode IDs increase with each recorded failure. */
  latest(): RecoveryEpisode | undefined {
    const row = this.sql.exec<EpisodeRow>(`${episodeSelect} ORDER BY id DESC LIMIT 1`).toArray()[0];
    return row === undefined ? undefined : episodeFromRow(row);
  }

  insert(episode: RecoveryEpisodeDraft): RecoveryEpisodeId {
    const values = episodeValues(episode);
    const row = this.sql
      .exec<{ readonly id: number }>(
        `INSERT INTO recovery_episodes (
           failure_event_id, failed_generation_label, fallback_generation_label, max_repair_attempts,
           recovery_budget_ms, operation_deadline_ms, started_at, recovery_deadline_at, attempts_used,
           phase, result, errors_text, repaired_harness_commit, verified_harness_commit,
           verified_generation_label, verified_preparation_check_id, operation_kind, operation_key,
           operation_attempt, operation_deadline_at, operation_state, preparation_check_id_at_open
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        ...values,
      )
      .one();
    return recoveryEpisodeId(row.id);
  }

  store(episode: RecoveryEpisode): void {
    const values = episodeValues(episode);
    this.sql.exec(
      `UPDATE recovery_episodes SET attempts_used = ?, phase = ?, result = ?, errors_text = ?,
         repaired_harness_commit = ?, verified_harness_commit = ?, verified_generation_label = ?,
         verified_preparation_check_id = ?, operation_kind = ?, operation_key = ?, operation_attempt = ?,
         operation_deadline_at = ?, operation_state = ?, preparation_check_id_at_open = ?
       WHERE id = ?`,
      ...values.slice(8),
      episode.id,
    );
  }
}

function episodeValues(episode: RecoveryEpisodeDraft | RecoveryEpisode) {
  const operation = episode.currentOperation;
  return [
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
    episode.repairedHarnessCommit ?? null,
    episode.verifiedHarnessCommit ?? null,
    episode.verifiedGenerationLabel ?? null,
    episode.verifiedPreparationCheckId ?? null,
    operation?.kind ?? null,
    operation?.key ?? null,
    operation?.attempt ?? null,
    operation?.deadlineAt ?? null,
    operation?.state ?? null,
    operation?.kind === "startup-check" ? operation.preparationCheckIdAtOpen : null,
  ] as const;
}
