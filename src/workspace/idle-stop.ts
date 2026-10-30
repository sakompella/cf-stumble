/**
 * Pure decision, no I/O. An open request keeps a Durable Object active and the Host holds an RPC
 * WebSocket to computerd for the whole run, so the platform never stops the container itself.
 */

export const WORKSPACE_IDLE_STOP_MS = 10 * 60 * 1_000;

/** What the Host knows about its work, in memory only: an evicted instance starts "just active". */
export type WorkspaceActivity = Readonly<{
  inFlight: number;
  lastActiveAtMs: number;
  leaseEndsAtMs: number | null;
}>;

type IdleStopDecision =
  | Readonly<{ kind: "stop"; idleForMs: number }>
  | Readonly<{ kind: "check-at"; atMs: number }>;

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
