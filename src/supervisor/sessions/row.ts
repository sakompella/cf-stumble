import type { SessionRecord } from "./session.js";

export type SessionRow = {
  readonly session_id: string;
  readonly document: string | null;
  readonly revision: number;
  readonly turn_active: number;
  readonly turn_deadline_at: number | null;
  readonly turn_lease_id?: string | null;
};

export function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    document: row.document ?? undefined,
    revision: row.revision,
    turnActive: row.turn_active === 1,
    turnDeadlineAt: row.turn_deadline_at ?? undefined,
  };
}
