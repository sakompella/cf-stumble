/// <reference types="@cloudflare/workers-types" />

import { assertNever, decideAbandonTurn, decideFinishTurn, decideStartTurn } from "./decisions.js";
import { sessionFromRow } from "./row.js";
import type { SessionRow } from "./row.js";
import { parseFacetTurnResult } from "./session.js";
import type { SessionDocument, SessionProblem, SessionRecord, SessionResult } from "./session.js";

export type {
  ExecutedCommand,
  FacetTurnResult,
  SessionDocument,
  SessionProblem,
  SessionRecord,
  SessionResult,
  SessionTurnOptions,
  SessionTurnProblem,
  SessionTurnResponse,
  SessionTurnResult,
} from "./session.js";

export { parseFacetTurnResult };

type SessionLease = Readonly<{ session: SessionRecord; leaseId: string }>;
type SessionLeaseResult =
  | { readonly ok: true; readonly lease: SessionLease }
  | { readonly ok: false; readonly problem: SessionProblem };

export class SessionStore {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        document TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        turn_active INTEGER NOT NULL DEFAULT 0 CHECK (turn_active IN (0, 1)),
        turn_deadline_at INTEGER,
        turn_lease_id TEXT
      );
    `);
    try {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN turn_lease_id TEXT");
    } catch {
      // Existing databases already have the column.
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.readRecord(sessionId);
  }

  startTurn(
    sessionId: string,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): SessionResult {
    const started = this.startTurnWithLease(sessionId, expectedRevision, now, leaseMs);
    return started.ok ? succeeded(started.lease.session) : rejected(started.problem);
  }

  startTurnWithLease(
    sessionId: string,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): SessionLeaseResult {
    const deadlineAt = now + leaseMs;
    const leaseId = crypto.randomUUID();

    return this.storage.transactionSync(() => {
      const decision = decideStartTurn(
        sessionId,
        this.readRecord(sessionId),
        expectedRevision,
        now,
      );
      switch (decision.kind) {
        case "rejected":
          return leaseRejected(decision.problem);
        case "started":
          this.sql.exec(
            `INSERT INTO sessions (session_id, document, revision, turn_active, turn_deadline_at, turn_lease_id)
             VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT (session_id) DO UPDATE SET
               turn_active = 1, turn_deadline_at = ?, turn_lease_id = ?`,
            sessionId,
            decision.document ?? null,
            decision.revision,
            deadlineAt,
            leaseId,
            deadlineAt,
            leaseId,
          );
          return leaseSucceeded({
            session: {
              sessionId,
              document: decision.document,
              revision: decision.revision,
              turnActive: true,
              turnDeadlineAt: deadlineAt,
            },
            leaseId,
          });
        default:
          return assertNever(decision);
      }
    });
  }

  finishTurn(
    sessionId: string,
    expectedRevision: number,
    document: SessionDocument,
    now: number,
  ): SessionResult {
    return this.storage.transactionSync(() => {
      const decision = decideFinishTurn(
        sessionId,
        this.readRecord(sessionId),
        expectedRevision,
        now,
      );
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "finished":
          this.writeFinished(sessionId, document, decision.nextRevision);
          return succeeded({
            sessionId,
            document,
            revision: decision.nextRevision,
            turnActive: false,
            turnDeadlineAt: undefined,
          });
        default:
          return assertNever(decision);
      }
    });
  }

  finishTurnWithLease(
    sessionId: string,
    expectedRevision: number,
    document: SessionDocument,
    now: number,
    leaseId: string,
  ): SessionResult {
    return this.storage.transactionSync(() => {
      const current = this.readRecord(sessionId);
      const decision = decideFinishTurn(sessionId, current, expectedRevision, now);
      if (decision.kind === "rejected") {
        return rejected(decision.problem);
      }
      if (!this.ownsLease(sessionId, leaseId)) {
        return rejected({ code: "turn-lease-lost", sessionId });
      }

      this.writeFinished(sessionId, document, decision.nextRevision);
      return succeeded({
        sessionId,
        document,
        revision: decision.nextRevision,
        turnActive: false,
        turnDeadlineAt: undefined,
      });
    });
  }

  abandonTurn(sessionId: string): SessionResult {
    return this.storage.transactionSync(() => {
      const decision = decideAbandonTurn(sessionId, this.readRecord(sessionId));
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "abandoned":
          this.clearLease(sessionId);
          return succeeded({
            sessionId,
            document: decision.document,
            revision: decision.revision,
            turnActive: false,
            turnDeadlineAt: undefined,
          });
        default:
          return assertNever(decision);
      }
    });
  }

  abandonTurnWithLease(sessionId: string, leaseId: string): SessionResult {
    return this.storage.transactionSync(() => {
      const current = this.readRecord(sessionId);
      if (current === undefined || !current.turnActive) {
        return rejected({ code: "turn-not-active", sessionId });
      }
      if (!this.ownsLease(sessionId, leaseId)) {
        return rejected({ code: "turn-lease-lost", sessionId });
      }

      this.clearLease(sessionId);
      return succeeded({
        sessionId,
        document: current.document,
        revision: current.revision,
        turnActive: false,
        turnDeadlineAt: undefined,
      });
    });
  }

  private writeFinished(sessionId: string, document: SessionDocument, revision: number): void {
    this.sql.exec(
      `UPDATE sessions
       SET document = ?, revision = ?, turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL
       WHERE session_id = ?`,
      document,
      revision,
      sessionId,
    );
  }

  private clearLease(sessionId: string): void {
    this.sql.exec(
      "UPDATE sessions SET turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL WHERE session_id = ?",
      sessionId,
    );
  }

  private ownsLease(sessionId: string, leaseId: string): boolean {
    const row = this.sql
      .exec<{ readonly turn_lease_id: string | null }>(
        "SELECT turn_lease_id FROM sessions WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0];
    return row?.turn_lease_id === leaseId;
  }

  private readRecord(sessionId: string): SessionRecord | undefined {
    const row = this.sql
      .exec<SessionRow>(
        `SELECT session_id, document, revision, turn_active, turn_deadline_at
         FROM sessions WHERE session_id = ?`,
        sessionId,
      )
      .toArray()[0];

    return row === undefined ? undefined : sessionFromRow(row);
  }
}

function succeeded(session: SessionRecord): SessionResult {
  return { ok: true, session };
}

function rejected(problem: SessionProblem): SessionResult {
  return { ok: false, problem };
}

function leaseSucceeded(lease: SessionLease): SessionLeaseResult {
  return { ok: true, lease };
}

function leaseRejected(problem: SessionProblem): SessionLeaseResult {
  return { ok: false, problem };
}

export { executeSessionTurn, sessionMountReason } from "./turn-operation.js";
export type { SessionFacetMount } from "./turn-operation.js";
