import { Result } from "better-result";
import { parseThreadMessages, type ThreadMessagesUnreadable } from "./messages.js";
import type { Project } from "../../project-catalog.js";
import type { ProjectThread } from "./thread.js";

export type ThreadRow = {
  readonly project_id: string;
  readonly messages: string | null;
  readonly revision: number;
  readonly turn_active: number;
  readonly turn_deadline_at: number | null;
  readonly turn_lease_id?: string | null;
};

/**
 * Turn one row into a thread. The project comes from the caller rather than from `project_id`,
 * because the caller resolved it against the catalog and the column is only what that resolved
 * value was written as.
 */
export function threadFromRow(
  project: Project,
  row: ThreadRow,
): Result<ProjectThread, ThreadMessagesUnreadable> {
  const messages = parseThreadMessages(row.messages);
  return messages.isErr()
    ? Result.err(messages.error)
    : Result.ok({
        projectId: project.id,
        messages: messages.value,
        revision: row.revision,
        turnActive: row.turn_active === 1,
        turnDeadlineAt: row.turn_deadline_at ?? undefined,
      });
}
