import type { ProjectId } from "../../project-catalog.js";

export type LiveTurn = Readonly<{ projectId: ProjectId; deadlineAt: number }>;

/**
 * Reads only the lease columns, so a damaged conversation cannot hide a lease. A lease taken by another
 * Supervisor instance is not live: that instance and its turn are gone, and admission takes it over.
 */
export function findLiveTurn(
  sql: SqlStorage,
  now: number,
  holderId: string | undefined,
  projectId?: ProjectId,
): LiveTurn | undefined {
  const row = sql
    .exec<{ readonly project_id: ProjectId; readonly turn_deadline_at: number }>(
      `SELECT project_id, turn_deadline_at FROM project_threads
       WHERE turn_active = 1 AND turn_deadline_at > ?1 AND (?2 IS NULL OR project_id = ?2)
         AND (?3 IS NULL OR turn_holder_id IS NULL OR turn_holder_id = ?3)
       ORDER BY turn_deadline_at DESC LIMIT 1`,
      now,
      projectId ?? null,
      holderId ?? null,
    )
    .toArray()[0];

  return row === undefined
    ? undefined
    : { projectId: row.project_id, deadlineAt: row.turn_deadline_at };
}
