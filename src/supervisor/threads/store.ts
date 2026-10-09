import type { AgentMessage } from "@cf-stumble/pi";
import { Result } from "better-result";
import {
  assertNever,
  decideAbandonTurn,
  decideFinishTurn,
  decideRemoveThread,
  decideStartTurn,
  type TurnLeaseClaim,
} from "./decisions.js";
import { serializeThreadMessages } from "./messages.js";
import { threadFromRow, type ThreadRow } from "./row.js";
import { emptyThread, type ProjectThread, type ThreadProblem } from "./thread.js";
import type { SelectableProject } from "../../selectable-projects.js";

export type ThreadLease = Readonly<{
  thread: ProjectThread;
  leaseId: string;
  reclaimed: boolean;
}>;

type ThreadRemovalProblem =
  | ThreadProblem
  | Readonly<{ code: "turn-active"; projectId: SelectableProject["id"]; deadlineAt: number }>;

const CLEAR_LEASE =
  "turn_active = 0, turn_deadline_at = NULL, turn_lease_id = NULL, turn_holder_id = NULL";

const RELEASED_TURN = {
  turnActive: false,
  turnDeadlineAt: undefined,
  turnHolderId: undefined,
} satisfies Partial<ProjectThread>;

/**
 * The one thread each selectable project has, and the lease that decides who may write to it.
 *
 * Every method takes a `SelectableProject`, never a project id string. A `SelectableProject` only
 * exists by resolving a client's string against the catalog, so a caller cannot reach a row this
 * store does not own, and cannot invent a thread for a project the tenant does not have. The
 * harness entry is one of those values, so it holds a row of its own and nothing here has to know
 * which kind it is.
 *
 * Admission is the only way to obtain a lease id, and finishing or abandoning a turn requires the
 * id that admitted it. The store mints that id itself, so no caller can name the turn it wants to
 * complete: it can only return what it was given.
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

  read(project: SelectableProject): Result<ProjectThread, ThreadProblem> {
    return this.readThread(project);
  }

  /**
   * Replace the project's conversation with an empty one (ADR-0038). Nothing here reaches the
   * project's Computer workspace, so the files a turn produced are untouched and only what was
   * said is gone.
   *
   * The row stays and its revision advances, which is what fences the turn that was running. A
   * deleted row would restart the count, and a delayed caller holding the replaced thread's
   * revision zero would be admitted into the replacement as if nothing had happened. Clearing the
   * lease stops that turn from committing, and advancing the revision stops it from starting
   * again; both hold without reading the conversation, so a damaged row is replaced rather than
   * reported.
   */
  startFreshThread(project: SelectableProject): ProjectThread {
    return this.storage.transactionSync(() => {
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

      return { ...emptyThread(project.id), revision: this.revisionOf(project) };
    });
  }

  /**
   * Admit one turn and hand back the lease that may complete it. The lease id is the store's, not
   * the caller's: it is minted here and returned once.
   */
  startTurn(
    project: SelectableProject,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): Result<ThreadLease, ThreadProblem> {
    const deadlineAt = now + leaseMs;
    const leaseId = crypto.randomUUID();

    return this.storage.transactionSync(() => {
      const current = this.readThread(project);

      if (current.isErr()) {
        return Result.err(current.error);
      }

      const reclaimed = this.previousInstanceLease(current.value);

      const decision = decideStartTurn(
        project.id,
        reclaimed ? { ...current.value, turnActive: false } : current.value,
        expectedRevision,
        now,
      );

      switch (decision.kind) {
        case "rejected":
          return Result.err(decision.problem);
        case "started":
          return this.persistStartedLease(
            project,
            current.value,
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
  ): Result<ThreadLease, ThreadProblem> {
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

    return Result.ok({ thread, leaseId, reclaimed });
  }

  /**
   * Commit the conversation a turn ended with. The lease decides whether this caller is still the
   * turn the thread admitted; the revision it was admitted at needs no restating, because every
   * commit and every fresh thread replaces the lease it would have to match.
   */
  finishTurn(
    project: SelectableProject,
    messages: readonly AgentMessage[],
    now: number,
    leaseId: string,
  ): Result<ProjectThread, ThreadProblem> {
    const stored = serializeThreadMessages(messages);

    return this.withLeaseClaim(project, leaseId, (current, claim) => {
      const decision = decideFinishTurn(project.id, current, claim, now);

      switch (decision.kind) {
        case "rejected":
          return Result.err(decision.problem);
        case "finished":
          this.sql.exec(
            `UPDATE project_threads SET messages = ?, revision = ?, ${CLEAR_LEASE} WHERE project_id = ?`,
            stored,
            decision.nextRevision,
            project.id,
          );

          return Result.ok({
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

  /** Delete the project's thread after confirming that no live turn owns it. */
  remove(project: SelectableProject, now: number): Result<void, ThreadRemovalProblem> {
    return this.storage.transactionSync(() => {
      const current = this.readThread(project);

      if (current.isErr()) return Result.err(current.error);

      const decision = decideRemoveThread(project.id, current.value, now);

      if (decision.kind === "rejected") return Result.err(decision.problem);

      this.sql.exec(`DELETE FROM project_threads WHERE project_id = ?`, project.id);

      return Result.ok();
    });
  }

  /** Give the turn slot back without writing a conversation, for the lease that holds it. */
  abandonTurn(project: SelectableProject, leaseId: string): Result<ProjectThread, ThreadProblem> {
    return this.withLeaseClaim(project, leaseId, (current, claim) => {
      const decision = decideAbandonTurn(project.id, current, claim);

      switch (decision.kind) {
        case "rejected":
          return Result.err(decision.problem);
        case "abandoned":
          this.sql.exec(
            `UPDATE project_threads SET ${CLEAR_LEASE} WHERE project_id = ?`,
            project.id,
          );

          return Result.ok({ ...current, ...RELEASED_TURN });
        default:
          return assertNever(decision);
      }
    });
  }

  /** Read the thread and the lease claim, then let `decide` judge and write, in one transaction. */
  private withLeaseClaim(
    project: SelectableProject,
    leaseId: string,
    decide: (current: ProjectThread, claim: TurnLeaseClaim) => Result<ProjectThread, ThreadProblem>,
  ): Result<ProjectThread, ThreadProblem> {
    return this.storage.transactionSync(() =>
      this.readThread(project).andThen((current) =>
        decide(current, this.leaseClaim(project, leaseId)),
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

  private readThread(project: SelectableProject): Result<ProjectThread, ThreadProblem> {
    const row = this.sql
      .exec<ThreadRow>(
        `SELECT project_id, messages, revision, turn_active, turn_deadline_at, turn_holder_id
         FROM project_threads WHERE project_id = ?`,
        project.id,
      )
      .toArray()[0];

    if (row === undefined) {
      return Result.ok(emptyThread(project.id));
    }

    return threadFromRow(project, row).mapError((unreadable): ThreadProblem => ({
      code: "unreadable-thread",
      projectId: project.id,
      reason: unreadable.reason,
    }));
  }
}
