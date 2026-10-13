import type { ProjectId } from "../../project-catalog.js";

/** A turn lease that its turn has not released and whose deadline has not passed. */
export type LiveTurn = Readonly<{ projectId: ProjectId; deadlineAt: number }>;

/**
 * The live lease that ends last, on one project or, without `projectId`, on any project or the
 * harness. It reads only the lease columns, so a damaged conversation cannot hide a lease. A lease
 * counts whichever Supervisor instance took it, because an instance that has since been replaced
 * may have left commands running in the workspace.
 */
export function findLiveTurn(
  sql: SqlStorage,
  now: number,
  projectId?: ProjectId,
): LiveTurn | undefined {
  const row = sql
    .exec<{ readonly project_id: ProjectId; readonly turn_deadline_at: number }>(
      `SELECT project_id, turn_deadline_at FROM project_threads
       WHERE turn_active = 1 AND turn_deadline_at > ?1 AND (?2 IS NULL OR project_id = ?2)
       ORDER BY turn_deadline_at DESC LIMIT 1`,
      now,
      projectId ?? null,
    )
    .toArray()[0];

  return row === undefined
    ? undefined
    : { projectId: row.project_id, deadlineAt: row.turn_deadline_at };
}
