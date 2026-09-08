import type { ActiveGeneration } from "../generations/index.js";
import { attemptFromRow } from "./attempt.js";
import type {
  AttemptRow,
  RelayAttempt,
  RelayAttribution,
  RelayOutcome,
  TurnTerminal,
} from "./attempt.js";

export type { RelayAttempt } from "./attempt.js";

export class RelayAttempts {
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
        finished_at INTEGER,
        turn_terminal TEXT CHECK (
          turn_terminal IS NULL OR turn_terminal IN ('completed', 'rejected', 'failed')
        )
      );
    `);
    this.addTurnTerminalColumn();
  }

  /**
   * `turn_terminal` joined this table after the first shape of it existed, and
   * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was. A Supervisor that
   * already has the old table gets the column added here, and every row it wrote keeps its
   * transport facts and reads with no turn terminal — which is all a row written before the
   * column existed can honestly claim. A turn those rows recorded as rejected or failed is
   * therefore still credited as a served response; only rows settled from now on carry the fact
   * that withholds the credit.
   */
  private addTurnTerminalColumn(): void {
    const columns = this.sql
      .exec<{ readonly name: string }>("SELECT name FROM pragma_table_info('relay_attempts')")
      .toArray();
    if (columns.some((column) => column.name === "turn_terminal")) {
      return;
    }

    this.sql.exec("ALTER TABLE relay_attempts ADD COLUMN turn_terminal TEXT");
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
           response_status, outcome, finished_at, turn_terminal
         ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL)
         RETURNING id, generation_label, activation_id, preparation_check_id, started_at,
                   deadline_at, response_status, outcome, finished_at, turn_terminal`,
        attribution.generationLabel ?? null,
        attribution.activationId ?? null,
        attribution.preparationCheckId ?? null,
        startedAt,
        startedAt + deadlineMs,
      )
      .one();

    return attemptFromRow(row);
  }

  headersReceived(attemptId: number, responseStatus: number): void {
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
    });
  }

  /**
   * Settle one pending attempt.
   *
   * `turnTerminal` is the extra fact a project turn has and an ordinary relayed request does not:
   * what the one terminal frame the Supervisor proved said the turn did. It is left out by every
   * caller that relayed something which was not a turn, because such a request proves nothing
   * about a turn either way.
   */
  settle(
    attemptId: number,
    outcome: Exclude<RelayOutcome, "pending">,
    observedAt: number,
    turnTerminal?: TurnTerminal,
  ): void {
    this.storage.transactionSync(() => {
      const attempt = this.byId(attemptId);
      if (attempt?.outcome !== "pending") {
        return;
      }

      this.sql.exec(
        "UPDATE relay_attempts SET outcome = ?, finished_at = ?, turn_terminal = ? WHERE id = ?",
        outcome,
        observedAt,
        turnTerminal ?? null,
        attemptId,
      );
    });
  }

  sweepExpired(now: number): readonly RelayAttempt[] {
    return this.storage.transactionSync(() => {
      const pending = this.sql
        .exec<AttemptRow>(
          `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                  deadline_at, response_status, outcome, finished_at, turn_terminal
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
      }

      return pending.map((attempt) => ({
        ...attempt,
        outcome: "bounded-abandonment",
        finishedAt: now,
      }));
    });
  }

  all(): readonly RelayAttempt[] {
    return this.sql
      .exec<AttemptRow>(
        `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                deadline_at, response_status, outcome, finished_at, turn_terminal
         FROM relay_attempts
         ORDER BY id ASC`,
      )
      .toArray()
      .map((row) => attemptFromRow(row));
  }

  /** One attempt as it currently stands. The turn path reads its own attempt at the commit. */
  byId(attemptId: number): RelayAttempt | undefined {
    const row = this.sql
      .exec<AttemptRow>(
        `SELECT id, generation_label, activation_id, preparation_check_id, started_at,
                deadline_at, response_status, outcome, finished_at, turn_terminal
         FROM relay_attempts
         WHERE id = ?`,
        attemptId,
      )
      .toArray()[0];

    return row === undefined ? undefined : attemptFromRow(row);
  }
}
