export const WORKSPACE_IDLE_STOP_MS = 10 * 60 * 1_000;

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
