import type { AgentMessage } from "@cf-stumble/pi";
import * as Result from "effect/Result";
import {
  assertNever,
  decideAbandonTurn,
  decideFinishTurn,
  decideStartTurn,
  type TurnLeaseClaim,
} from "./decisions.js";
import { findLiveTurn, type LiveTurn } from "./live-turn.js";
import { serializeThreadMessages } from "./messages.js";
import { threadFromRow, type ThreadRow } from "./row.js";
import { emptyThread, type ProjectThread, type ThreadProblem } from "./thread.js";
import type { SelectableProject } from "../../selectable-projects.js";

export type ThreadLease = Readonly<{
  thread: ProjectThread;
  leaseId: string;
  reclaimed: boolean;
}>;

const CLEAR_LEASE =
  "turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL, turn_holder_id = NULL";

const RELEASED_TURN = {
  turnActive: false,
  turnDeadlineAt: undefined,
  turnHolderId: undefined,
} satisfies Partial<ProjectThread>;

/**
 * Methods take a `SelectableProject`, never a string, so a caller cannot reach a row this store does not
 * own. The store mints the lease id, so no caller can name the turn it wants to complete.
 */
export class ThreadStore {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;
  private readonly holderId: string | undefined;

  constructor(storage: DurableObjectStorage, holderId?: string) {
    this.storage = storage;
    this.sql = storage.sql;
    this.holderId = holderId;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_threads (
        project_id TEXT PRIMARY KEY,
        messages TEXT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        turn_active INTEGER NOT NULL DEFAULT 0 CHECK (turn_active IN (0, 1)),
        turn_deadline_at INTEGER,
        turn_lease_id TEXT,
        turn_holder_id TEXT
      );
    `);
  }

  read(project: SelectableProject): Result.Result<ProjectThread, ThreadProblem> {
    return this.readThread(project);
  }

  /**
   * The row stays and its revision advances: a deleted row would restart the count, and a delayed caller
   * holding revision zero would be admitted into the replacement. A live lease refuses it, since the
   * running turn would lose its save but keep editing files.
   */
  startFreshThread(
    project: SelectableProject,
    now: number,
  ): Result.Result<ProjectThread, ThreadProblem> {
    return this.storage.transactionSync(() => {
      const live = this.liveTurn(now, project);

      if (live !== undefined) return Result.fail({ code: "turn-active", ...live });

      this.sql.exec(
        `INSERT INTO project_threads (project_id, messages, revision, turn_active, turn_deadline_at, turn_lease_id, turn_holder_id)
         VALUES (?, NULL, 0, 0, NULL, NULL, NULL)
         ON CONFLICT (project_id) DO UPDATE SET
           messages = NULL,
           revision = revision + 1,
           turn_active = 0,
           turn_deadline_at = NULL,
           turn_lease_id = NULL,
           turn_holder_id = NULL`,
        project.id,
      );

      return Result.succeed({ ...emptyThread(project.id), revision: this.revisionOf(project) });
    });
  }

  startTurn(
    project: SelectableProject,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): Result.Result<ThreadLease, ThreadProblem> {
    const deadlineAt = now + leaseMs;
    const leaseId = crypto.randomUUID();

    return this.storage.transactionSync(() => {
      const current = this.readThread(project);

      if (Result.isFailure(current)) {
        return Result.fail(current.failure);
      }

      const reclaimed = this.previousInstanceLease(current.success);

      const decision = decideStartTurn(
        project.id,
        reclaimed ? { ...current.success, turnActive: false } : current.success,
        expectedRevision,
        now,
      );

      switch (decision.kind) {
        case "rejected":
          return Result.fail(decision.problem);
        case "started":
          return this.persistStartedLease(
            project,
            current.success,
            decision.revision,
            deadlineAt,
            leaseId,
            reclaimed,
          );
        default:
          return assertNever(decision);
      }
    });
  }

  private persistStartedLease(
    project: SelectableProject,
    current: ProjectThread,
    revision: number,
    deadlineAt: number,
    leaseId: string,
    reclaimed: boolean,
  ): Result.Result<ThreadLease, ThreadProblem> {
    this.sql.exec(
      `INSERT INTO project_threads (project_id, messages, revision, turn_active, turn_deadline_at, turn_lease_id, turn_holder_id)
       VALUES (?, NULL, ?, 1, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         turn_active = 1, turn_deadline_at = ?, turn_lease_id = ?, turn_holder_id = ?`,
      project.id,
      revision,
      deadlineAt,
      leaseId,
      this.holderId ?? null,
      deadlineAt,
      leaseId,
      this.holderId ?? null,
    );

    const thread = {
      ...current,
      turnActive: true,
      turnDeadlineAt: deadlineAt,
      turnHolderId: this.holderId,
    };

    return Result.succeed({ thread, leaseId, reclaimed });
  }

  /** Needs no revision: every commit and fresh thread replaces the lease it would have to match. */
  finishTurn(
    project: SelectableProject,
    messages: readonly AgentMessage[],
    now: number,
    leaseId: string,
  ): Result.Result<ProjectThread, ThreadProblem> {
    const stored = serializeThreadMessages(messages);

    return this.withLeaseClaim(project, leaseId, (current, claim) => {
      const decision = decideFinishTurn(project.id, current, claim, now);

      switch (decision.kind) {
        case "rejected":
          return Result.fail(decision.problem);
        case "finished":
          this.sql.exec(
            `UPDATE project_threads SET messages = ?, revision = ?, ${CLEAR_LEASE} WHERE project_id = ?`,
            stored,
            decision.nextRevision,
            project.id,
          );

          return Result.succeed({
            projectId: project.id,
            messages,
            revision: decision.nextRevision,
            ...RELEASED_TURN,
          });
        default:
          return assertNever(decision);
      }
    });
  }

  liveTurn(now: number, project?: SelectableProject): LiveTurn | undefined {
    return findLiveTurn(this.sql, now, this.holderId, project?.id);
  }

  remove(project: SelectableProject, now: number): Result.Result<void, ThreadProblem> {
    return this.storage.transactionSync(() => {
      const current = this.readThread(project);

      if (Result.isFailure(current)) return Result.fail(current.failure);

      const live = this.liveTurn(now, project);

      if (live !== undefined) return Result.fail({ code: "turn-active", ...live });

      this.sql.exec(`DELETE FROM project_threads WHERE project_id = ?`, project.id);

      return Result.void;
    });
  }

  abandonTurn(
    project: SelectableProject,
    leaseId: string,
  ): Result.Result<ProjectThread, ThreadProblem> {
    return this.withLeaseClaim(project, leaseId, (current, claim) => {
      const decision = decideAbandonTurn(project.id, current, claim);

      switch (decision.kind) {
        case "rejected":
          return Result.fail(decision.problem);
        case "abandoned":
          this.sql.exec(
            `UPDATE project_threads SET ${CLEAR_LEASE} WHERE project_id = ?`,
            project.id,
          );

          return Result.succeed({ ...current, ...RELEASED_TURN });
        default:
          return assertNever(decision);
      }
    });
  }

  private withLeaseClaim(
    project: SelectableProject,
    leaseId: string,
    decide: (
      current: ProjectThread,
      claim: TurnLeaseClaim,
    ) => Result.Result<ProjectThread, ThreadProblem>,
  ): Result.Result<ProjectThread, ThreadProblem> {
    return this.storage.transactionSync(() =>
      this.readThread(project).pipe(
        Result.flatMap((current) => decide(current, this.leaseClaim(project, leaseId))),
      ),
    );
  }

  private previousInstanceLease(thread: ProjectThread): boolean {
    return (
      this.holderId !== undefined &&
      thread.turnActive &&
      thread.turnHolderId !== undefined &&
      thread.turnHolderId !== this.holderId
    );
  }

  private leaseClaim(project: SelectableProject, presented: string): TurnLeaseClaim {
    const row = this.sql
      .exec<{ readonly turn_lease_id: string | null }>(
        "SELECT turn_lease_id FROM project_threads WHERE project_id = ?",
        project.id,
      )
      .toArray()[0];

    return { held: row?.turn_lease_id ?? undefined, presented };
  }

  private revisionOf(project: SelectableProject): number {
    const row = this.sql
      .exec<{ readonly revision: number }>(
        "SELECT revision FROM project_threads WHERE project_id = ?",
        project.id,
      )
      .toArray()[0];

    return row?.revision ?? 0;
  }

  private readThread(project: SelectableProject): Result.Result<ProjectThread, ThreadProblem> {
    const row = this.sql
      .exec<ThreadRow>(
        `SELECT project_id, messages, revision, turn_active, turn_deadline_at, turn_holder_id
         FROM project_threads WHERE project_id = ?`,
        project.id,
      )
      .toArray()[0];

    if (row === undefined) {
      return Result.succeed(emptyThread(project.id));
    }

    return threadFromRow(project, row).pipe(
      Result.mapError((unreadable): ThreadProblem => ({
        code: "unreadable-thread",
        projectId: project.id,
        reason: unreadable.reason,
      })),
    );
  }
}
