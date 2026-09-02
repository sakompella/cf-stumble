/// <reference types="@cloudflare/workers-types" />

import { assertNever, decideAbandonTurn, decideFinishTurn, decideStartTurn } from "./decisions.js";
import { sessionFromRow } from "./row.js";
import type { SessionRow } from "./row.js";
import type { SessionDocument, SessionProblem, SessionRecord, SessionResult } from "./session.js";

export type { SessionDocument, SessionProblem, SessionRecord, SessionResult } from "./session.js";

/**
 * Owns session documents for the Supervisor. A session's contents are opaque to this store: it
 * stores and returns the caller's document string without reading it, and generation code owns
 * that document's schema. This table names no generation, activation or harness commit, so a
 * session survives a generation change or a facet replacement by construction, not by convention.
 *
 * Every mutating method is an imperative shell around a pure decider in ./decisions.ts, the split
 * ADR-0036 names. A Durable Object serializes its storage transactions, so the read-decide-write
 * sequence below cannot interleave with another call for the same session.
 */
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
        turn_deadline_at INTEGER
      );
    `);
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
    const deadlineAt = now + leaseMs;

    return this.storage.transactionSync(() => {
      const decision = decideStartTurn(
        sessionId,
        this.readRecord(sessionId),
        expectedRevision,
        now,
      );
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "started":
          this.sql.exec(
            `INSERT INTO sessions (session_id, document, revision, turn_active, turn_deadline_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT (session_id) DO UPDATE SET turn_active = 1, turn_deadline_at = ?`,
            sessionId,
            decision.document ?? null,
            decision.revision,
            deadlineAt,
            deadlineAt,
          );
          return succeeded({
            sessionId,
            document: decision.document,
            revision: decision.revision,
            turnActive: true,
            turnDeadlineAt: deadlineAt,
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
          this.sql.exec(
            `UPDATE sessions
             SET document = ?, revision = ?, turn_active = 0, turn_deadline_at = NULL
             WHERE session_id = ?`,
            document,
            decision.nextRevision,
            sessionId,
          );
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

  abandonTurn(sessionId: string): SessionResult {
    return this.storage.transactionSync(() => {
      const decision = decideAbandonTurn(sessionId, this.readRecord(sessionId));
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "abandoned":
          this.sql.exec(
            "UPDATE sessions SET turn_active = 0, turn_deadline_at = NULL WHERE session_id = ?",
            sessionId,
          );
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
