/**
 * Every threshold `ops:check` applies, named and explained.
 *
 * These are reporting thresholds for an operator, not runtime limits. Each one is tuned to catch
 * a specific incident within an hour: the 09-26 credential poller and the 09-27 unowned CPU run.
 */
import { MINUTE_MS } from "./model.mts";

/** A request that ran this long held the workspace long enough to matter; the poller ran 90 s. */
export const SLOW_REQUEST_MS = 30_000;

/** Slow or canceled requests on one route per rolling hour that make the route a finding. */
export const SLOW_REQUESTS_PER_HOUR = 10;

/** Calls to one route per rolling hour before it can be called a poller. The incident had 38. */
export const POLLER_CALLS_PER_HOUR = 20;

/** Of those calls, how many must reach the workspace (share a requestId with workspace work). */
export const POLLER_WORKSPACE_TOUCHES = 10;

/** Of those calls, the canceled share above which the route is a poller regardless of touches. */
export const POLLER_CANCELED_SHARE = 0.1;

/** Container CPU-seconds in a five-minute bucket above which the bucket is busy: 0.1 vCPU. */
export const BUSY_CPU_SECONDS_PER_BUCKET = 30;

/** Consecutive busy buckets with no owner work that make a finding: 30 minutes. */
export const UNOWNED_RUN_MS = 30 * MINUTE_MS;

/** Running time beyond the idle limit that is tolerated before a finding: the stop is not exact. */
export const IDLE_OVERRUN_TOLERANCE_MS = 10 * MINUTE_MS;

/**
 * Metrics lag the clock by a few minutes: on 2026-10-02 the newest bucket was still filling and
 * the container looked stopped when it was not. Buckets that end inside this span are incomplete,
 * so the rules skip them and the instances API answers for the present.
 */
export const METRICS_LAG_MS = 10 * MINUTE_MS;

/** Default idle limit, as a parameter of the check. */
export const DEFAULT_IDLE_LIMIT_MS = 20 * MINUTE_MS;

/**
 * Time after `workspace.container.started` that counts as owner work. The launch call returns
 * before the container boots, and the first status read and provisioning run before they log.
 */
export const STARTUP_GRACE_MS = 10 * MINUTE_MS;

/** A backend close this close to the Host\'s own stop or wake request is part of that restart. */
export const RESTART_CLOSE_WINDOW_MS = 10_000;

/** Most evidence ids printed on one line. */
export const MAX_EVIDENCE = 3;

/** The query row limit of the telemetry API. A query that returns this many may be cut off. */
export const TELEMETRY_ROW_LIMIT = 2000;
