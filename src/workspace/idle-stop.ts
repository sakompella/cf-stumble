/**
 * When an idle workspace container may stop (a pure decision, no I/O). The Host holds one RPC WebSocket open to
 * computerd for the whole container run, and an open request keeps a Durable Object active, so the
 * platform never stops the container by itself.
 */

export const WORKSPACE_IDLE_STOP_MS = 10 * 60 * 1_000;

/** What the Host knows about its work, in memory only: an evicted instance starts "just active". */
export type WorkspaceActivity = Readonly<{
  /** Host RPCs and project exec operations that have not settled. */
  inFlight: number;
  lastActiveAtMs: number;
  /** The latest turn deadline `project()` handed out, or `null`. Work may still arrive until then. */
  leaseEndsAtMs: number | null;
}>;

type IdleStopDecision =
  | Readonly<{ kind: "stop"; idleForMs: number }>
  | Readonly<{ kind: "check-at"; atMs: number }>;

/**
 * Stop only when nothing is in flight and the limit has passed since the later of the last
 * activity and the end of the lease. Otherwise say when to look again.
 */
export function decideIdleStop(
  activity: WorkspaceActivity,
  nowMs: number,
  idleLimitMs: number,
): IdleStopDecision {
  if (activity.inFlight > 0) return { kind: "check-at", atMs: nowMs + idleLimitMs };

  const idleSinceMs = Math.max(activity.lastActiveAtMs, activity.leaseEndsAtMs ?? 0);
  const dueAtMs = idleSinceMs + idleLimitMs;

  if (nowMs < dueAtMs) return { kind: "check-at", atMs: dueAtMs };

  return { kind: "stop", idleForMs: nowMs - idleSinceMs };
}
