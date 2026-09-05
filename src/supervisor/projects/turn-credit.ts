/// <reference types="@cloudflare/workers-types" />

import type { RelayAttempt } from "../relay/index.js";

/**
 * One completed real turn: a turn whose Pi work reached terminal success and whose conversation
 * was committed to the project's thread under the lease that admitted it (goal criterion 6).
 *
 * The row is keyed by the relay attempt the turn was recorded as, so one turn can earn one credit
 * and a retry of the same write cannot invent a second. The generation attribution is copied from
 * that attempt, which snapshots it at admission: a generation activated while the turn was
 * running does not relabel evidence the previous one produced.
 *
 * This ledger is separate from `relay_attempts` on purpose. Relay attempts answer whether a
 * generation is known good (ADR-0031); this answers whether the user got a turn that survived.
 * Nothing in `eligibility.ts` reads this table, so a storage failure here cannot change which
 * generation is eligible, and a credited relay attempt does not imply a saved thread.
 */
export type CompletedRealTurnCredit = Readonly<{
  attemptId: number;
  projectId: string;
  leaseId: string;
  threadRevision: number;
  generationLabel: number | undefined;
  activationId: number | undefined;
  preparationCheckId: number | undefined;
  creditedAt: number;
}>;

type CreditRow = {
  readonly attempt_id: number;
  readonly project_id: string;
  readonly lease_id: string;
  readonly thread_revision: number;
  readonly generation_label: number | null;
  readonly activation_id: number | null;
  readonly preparation_check_id: number | null;
  readonly credited_at: number;
};

function creditFromRow(row: CreditRow): CompletedRealTurnCredit {
  return {
    attemptId: row.attempt_id,
    projectId: row.project_id,
    leaseId: row.lease_id,
    threadRevision: row.thread_revision,
    generationLabel: row.generation_label ?? undefined,
    activationId: row.activation_id ?? undefined,
    preparationCheckId: row.preparation_check_id ?? undefined,
    creditedAt: row.credited_at,
  };
}

/** What one credit is written from: the turn's attempt, the lease it held, and what it saved. */
export type TurnCreditInput = Readonly<{
  attempt: RelayAttempt;
  projectId: string;
  leaseId: string;
  threadRevision: number;
  creditedAt: number;
}>;

export class TurnCredits {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS completed_real_turns (
        attempt_id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        thread_revision INTEGER NOT NULL,
        generation_label INTEGER,
        activation_id INTEGER,
        preparation_check_id INTEGER,
        credited_at INTEGER NOT NULL
      );
    `);
  }

  /** Write the one credit this attempt may earn. A second write for it changes nothing. */
  record(input: TurnCreditInput): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO completed_real_turns (
         attempt_id, project_id, lease_id, thread_revision, generation_label, activation_id,
         preparation_check_id, credited_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.attempt.id,
      input.projectId,
      input.leaseId,
      input.threadRevision,
      input.attempt.generationLabel ?? null,
      input.attempt.activationId ?? null,
      input.attempt.preparationCheckId ?? null,
      input.creditedAt,
    );
  }

  all(): readonly CompletedRealTurnCredit[] {
    return this.sql
      .exec<CreditRow>(
        `SELECT attempt_id, project_id, lease_id, thread_revision, generation_label,
                activation_id, preparation_check_id, credited_at
         FROM completed_real_turns
         ORDER BY attempt_id ASC`,
      )
      .toArray()
      .map((row) => creditFromRow(row));
  }
}
