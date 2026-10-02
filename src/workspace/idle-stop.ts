/**
 * When an idle workspace container may stop (ADR-0036: a pure decision, no I/O).
 *
 * The Workspace Host holds one RPC WebSocket open to computerd for the whole container run, and an
 * open request keeps a Durable Object active, so the platform never stops the container by
 * itself. The Host therefore stops an idle container on purpose, and this module says when.
 */

/** How long the workspace must have no work before the Host stops its container. */
export const WORKSPACE_IDLE_STOP_MS = 10 * 60 * 1_000;

/**
 * What the Host knows about its workspace work. It lives in memory only: an instance that was
 * evicted has no WebSocket and starts again at "just active".
 */
export type WorkspaceActivity = Readonly<{
  /** Host RPCs and project exec operations that have not settled. */
  inFlight: number;
  /** When the last unit of work settled, or when this instance was built. */
  lastActiveAtMs: number;
  /** The latest turn deadline `project()` handed out, or `null`. Work may still arrive until then. */
  leaseEndsAtMs: number | null;
}>;

export type IdleStopDecision =
  | Readonly<{ kind: "stop"; idleForMs: number }>
  | Readonly<{ kind: "check-at"; atMs: number }>;

/**
 * Stop only when nothing is in flight and the limit has passed since the later of the last
 * activity and the end of the lease. Otherwise say when to look again: a full limit from now while
 * work is in flight, or the moment the limit would pass.
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
