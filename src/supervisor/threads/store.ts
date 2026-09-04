/// <reference types="@cloudflare/workers-types" />

import type { AgentMessage } from "@cf-stumble/pi";
import { assertNever, decideAbandonTurn, decideFinishTurn, decideStartTurn } from "./decisions.js";
import { serializeThreadMessages } from "./messages.js";
import { threadFromRow, type ThreadRow } from "./row.js";
import {
  emptyThread,
  type ProjectThread,
  type ThreadProblem,
  type ThreadResult,
} from "./thread.js";
import type { Project } from "../../project-catalog.js";

export type ThreadLease = Readonly<{ thread: ProjectThread; leaseId: string }>;

export type ThreadLeaseResult =
  | Readonly<{ ok: true; lease: ThreadLease }>
  | Readonly<{ ok: false; problem: ThreadProblem }>;

/**
 * The one thread each catalog project has, and the lease that decides who may write to it.
 *
 * Every method takes a `Project`, never a project id string. A `Project` only exists by resolving
 * a client's string against the catalog, so a caller cannot reach a row this store does not own,
 * and cannot invent a thread for a project the tenant does not have.
 */
export class ThreadStore {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_threads (
        project_id TEXT PRIMARY KEY,
        messages TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        turn_active INTEGER NOT NULL DEFAULT 0 CHECK (turn_active IN (0, 1)),
        turn_deadline_at INTEGER,
        turn_lease_id TEXT
      );
    `);
  }

  read(project: Project): ThreadResult {
    return this.readThread(project);
  }

  /**
   * Replace the project's conversation with an empty one (ADR-0038). This removes the stored
   * thread and, with it, the lease: nothing here reaches the project's Computer workspace, so the
   * files a turn produced are untouched and only what was said is gone. A turn that was running
   * can no longer finish into the thread, because its revision and its lease went with the row.
   */
  startFreshThread(project: Project): ThreadResult {
    return this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM project_threads WHERE project_id = ?", project.id);
      return succeeded(emptyThread(project.id));
    });
  }

  startTurn(
    project: Project,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): ThreadResult {
    const started = this.startTurnWithLease(project, expectedRevision, now, leaseMs);
    return started.ok ? succeeded(started.lease.thread) : rejected(started.problem);
  }

  startTurnWithLease(
    project: Project,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): ThreadLeaseResult {
    const deadlineAt = now + leaseMs;
    const leaseId = crypto.randomUUID();

    return this.storage.transactionSync(() => {
      const current = this.readThread(project);
      if (!current.ok) {
        return leaseRejected(current.problem);
      }

      const decision = decideStartTurn(project.id, current.thread, expectedRevision, now);
      switch (decision.kind) {
        case "rejected":
          return leaseRejected(decision.problem);
        case "started": {
          this.sql.exec(
            `INSERT INTO project_threads (project_id, messages, revision, turn_active, turn_deadline_at, turn_lease_id)
             VALUES (?, NULL, ?, 1, ?, ?)
             ON CONFLICT (project_id) DO UPDATE SET
               turn_active = 1, turn_deadline_at = ?, turn_lease_id = ?`,
            project.id,
            decision.revision,
            deadlineAt,
            leaseId,
            deadlineAt,
            leaseId,
          );
          const thread = { ...current.thread, turnActive: true, turnDeadlineAt: deadlineAt };
          return leaseSucceeded({ thread, leaseId });
        }
        default:
          return assertNever(decision);
      }
    });
  }

  finishTurn(
    project: Project,
    expectedRevision: number,
    messages: readonly AgentMessage[],
    now: number,
  ): ThreadResult {
    return this.commitTurn(project, expectedRevision, messages, now);
  }

  finishTurnWithLease(
    project: Project,
    expectedRevision: number,
    messages: readonly AgentMessage[],
    now: number,
    leaseId: string,
  ): ThreadResult {
    return this.commitTurn(project, expectedRevision, messages, now, leaseId);
  }

  abandonTurn(project: Project): ThreadResult {
    return this.releaseTurn(project);
  }

  abandonTurnWithLease(project: Project, leaseId: string): ThreadResult {
    return this.releaseTurn(project, leaseId);
  }

  private commitTurn(
    project: Project,
    expectedRevision: number,
    messages: readonly AgentMessage[],
    now: number,
    leaseId?: string,
  ): ThreadResult {
    const stored = serializeThreadMessages(messages);

    return this.storage.transactionSync(() => {
      const current = this.readThread(project);
      if (!current.ok) {
        return rejected(current.problem);
      }

      const decision = decideFinishTurn(project.id, current.thread, expectedRevision, now);
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "finished": {
          if (leaseId !== undefined && !this.ownsLease(project, leaseId)) {
            return rejected({ code: "turn-lease-lost", projectId: project.id });
          }
          this.sql.exec(
            `UPDATE project_threads
             SET messages = ?, revision = ?, turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL
             WHERE project_id = ?`,
            stored,
            decision.nextRevision,
            project.id,
          );
          return succeeded({
            projectId: project.id,
            messages,
            revision: decision.nextRevision,
            turnActive: false,
            turnDeadlineAt: undefined,
          });
        }
        default:
          return assertNever(decision);
      }
    });
  }

  private releaseTurn(project: Project, leaseId?: string): ThreadResult {
    return this.storage.transactionSync(() => {
      const current = this.readThread(project);
      if (!current.ok) {
        return rejected(current.problem);
      }

      const decision = decideAbandonTurn(project.id, current.thread);
      switch (decision.kind) {
        case "rejected":
          return rejected(decision.problem);
        case "abandoned": {
          if (leaseId !== undefined && !this.ownsLease(project, leaseId)) {
            return rejected({ code: "turn-lease-lost", projectId: project.id });
          }
          this.sql.exec(
            `UPDATE project_threads
             SET turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL
             WHERE project_id = ?`,
            project.id,
          );
          return succeeded({
            ...current.thread,
            turnActive: false,
            turnDeadlineAt: undefined,
          });
        }
        default:
          return assertNever(decision);
      }
    });
  }

  private ownsLease(project: Project, leaseId: string): boolean {
    const row = this.sql
      .exec<{ readonly turn_lease_id: string | null }>(
        "SELECT turn_lease_id FROM project_threads WHERE project_id = ?",
        project.id,
      )
      .toArray()[0];
    return row?.turn_lease_id === leaseId;
  }

  private readThread(project: Project): ThreadResult {
    const row = this.sql
      .exec<ThreadRow>(
        `SELECT project_id, messages, revision, turn_active, turn_deadline_at
         FROM project_threads WHERE project_id = ?`,
        project.id,
      )
      .toArray()[0];
    if (row === undefined) {
      return succeeded(emptyThread(project.id));
    }

    const thread = threadFromRow(project, row);
    return thread.isErr()
      ? rejected({ code: "unreadable-thread", projectId: project.id, reason: thread.error.reason })
      : succeeded(thread.value);
  }
}

function succeeded(thread: ProjectThread): ThreadResult {
  return { ok: true, thread };
}

function rejected(problem: ThreadProblem): ThreadResult {
  return { ok: false, problem };
}

function leaseSucceeded(lease: ThreadLease): ThreadLeaseResult {
  return { ok: true, lease };
}

function leaseRejected(problem: ThreadProblem): ThreadLeaseResult {
  return { ok: false, problem };
}
