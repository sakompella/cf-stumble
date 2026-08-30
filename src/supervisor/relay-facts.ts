import type { ActiveGeneration } from "./generations.js";
import { attemptFromRow, factFromRow } from "./relay-types.js";
import type {
  AttemptRow,
  FactRow,
  RelayAttempt,
  RelayAttribution,
  RelayFact,
  RelayFactKind,
  RelayOutcome,
} from "./relay-types.js";

export type { RelayAttempt, RelayFact } from "./relay-types.js";

export class RelayFacts {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_label INTEGER,
        activation_id INTEGER,
        preparation_check_id INTEGER,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        response_status INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN (
          'pending', 'pre-header-failure', 'body-completed', 'body-failed',
          'relay-cancelled', 'bounded-abandonment'
        )),
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS relay_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL,
        generation_label INTEGER,
        activation_id INTEGER,
        preparation_check_id INTEGER,
        kind TEXT NOT NULL CHECK (kind IN (
          'headers-received', 'pre-header-failure', 'body-completed', 'body-failed',
          'relay-cancelled', 'bounded-abandonment'
        )),
        response_status INTEGER,
        observed_at INTEGER NOT NULL
      );
    `);
  }

  start(
    active: ActiveGeneration,
    preparationCheckId: number | undefined,
    startedAt: number,
    deadlineMs: number,
  ): RelayAttempt {
    const attribution: RelayAttribution = {
      generationLabel: active.generation?.label,
      activationId: active.activationId,
      preparationCheckId,
    };
    const row = this.sql
      .exec<AttemptRow>(
        `INSERT INTO relay_attempts (
           generation_label, activation_id, preparation_check_id, started_at, deadline_at,
           response_status, outcome, finished_at
         ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL)
         RETURNING id, generation_label, activation_id, preparation_check_id, started_at,
                   deadline_at, response_status, outcome, finished_at`,
        attribution.generationLabel ?? null,
        attribution.activationId ?? null,
        attribution.preparationCheckId ?? null,
        startedAt,
        startedAt + deadlineMs,
      )
      .one();

    return attemptFromRow(row);
  }

  headersReceived(attemptId: number, responseStatus: number, observedAt: number): void {
    this.storage.transactionSync(() => {
      const attempt = this.byId(attemptId);
      if (attempt?.outcome !== "pending" || attempt.responseStatus !== undefined) {
        return;
      }

      this.sql.exec(
        "UPDATE relay_attempts SET response_status = ? WHERE id = ?",
        responseStatus,
        attemptId,
      );
      this.recordFact(attempt, "headers-received", responseStatus, observedAt);
    });
  }

  settle(attemptId: number, outcome: Exclude<RelayOutcome, "pending">, observedAt: number): void {
    this.storage.transactionSync(() => {
      const attempt = this.byId(attemptId);
      if (attempt?.outcome !== "pending") {
        return;
      }

      this.sql.exec(
        "UPDATE relay_attempts SET outcome = ?, finished_at = ? WHERE id = ?",
        outcome,
        observedAt,
        attemptId,
      );
      this.recordFact(attempt, outcome, attempt.responseStatus, observedAt);
    });
  }

  sweepExpired(now: number): readonly RelayAttempt[] {
    return this.storage.transactionSync(() => {
      const pending = this.sql
        .exec<AttemptRow>(
          `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                  deadline_at, response_status, outcome, finished_at
           FROM relay_attempts
           WHERE outcome = 'pending' AND deadline_at <= ?
           ORDER BY id ASC`,
          now,
        )
        .toArray()
        .map((row) => attemptFromRow(row));

      for (const attempt of pending) {
        this.sql.exec(
          "UPDATE relay_attempts SET outcome = 'bounded-abandonment', finished_at = ? WHERE id = ?",
          now,
          attempt.id,
        );
        this.recordFact(attempt, "bounded-abandonment", attempt.responseStatus, now);
      }

      return pending.map((attempt) => ({
        ...attempt,
        outcome: "bounded-abandonment",
        finishedAt: now,
      }));
    });
  }

  attempts(): readonly RelayAttempt[] {
    return this.sql
      .exec<AttemptRow>(
        `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                deadline_at, response_status, outcome, finished_at
         FROM relay_attempts
         ORDER BY id ASC`,
      )
      .toArray()
      .map((row) => attemptFromRow(row));
  }

  facts(): readonly RelayFact[] {
    return this.sql
      .exec<FactRow>(
        `SELECT attempt_id, generation_label, activation_id, preparation_check_id, kind,
                response_status, observed_at
         FROM relay_facts
         ORDER BY id ASC`,
      )
      .toArray()
      .map((row) => factFromRow(row));
  }

  private byId(attemptId: number): RelayAttempt | undefined {
    const row = this.sql
      .exec<AttemptRow>(
        `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                deadline_at, response_status, outcome, finished_at
         FROM relay_attempts
         WHERE id = ?`,
        attemptId,
      )
      .toArray()[0];

    return row === undefined ? undefined : attemptFromRow(row);
  }

  private recordFact(
    attempt: RelayAttempt,
    kind: RelayFactKind,
    responseStatus: number | undefined,
    observedAt: number,
  ): void {
    this.sql.exec(
      `INSERT INTO relay_facts (
         attempt_id, generation_label, activation_id, preparation_check_id, kind,
         response_status, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      attempt.id,
      attempt.generationLabel ?? null,
      attempt.activationId ?? null,
      attempt.preparationCheckId ?? null,
      kind,
      responseStatus ?? null,
      observedAt,
    );
  }
}
