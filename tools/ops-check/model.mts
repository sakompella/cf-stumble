/**
 * The typed inputs and outputs of `ops:check`.
 *
 * Network responses are parsed into these types once, at the boundary (`parse.mts`). The rules
 * only ever see these types, so a rule cannot read a missing field or confuse "no data" with
 * "zero". A source that failed or returned nothing is `unavailable`, never an empty list that a
 * rule would read as a quiet system.
 */

export type EventLevel = "info" | "warn" | "error" | "other";

/** One structured event from our own `logEvent`, with the fields the rules read. */
export interface AppEvent {
  readonly atMs: number;
  readonly name: string;
  readonly level: EventLevel;
  readonly requestId: string | null;
  /** How long the event's work ran before `atMs`: `durationMs`, `totalMs` or `elapsedMs`; else 0. */
  readonly spanMs: number;
  readonly route: string | null;
  readonly applicationOutcome: string | null;
  readonly running: boolean | null;
  readonly reasonCode: string | null;
  readonly reasonSource: string | null;
  /** `route.settled` only: `headers` for a streamed response whose work continues. */
  readonly phase: string | null;
  /** `workspace.backend.closed` only: `transport-closed`, `connect-failed` or `idle-stop`. */
  readonly trigger: string | null;
  /** `workspace.rpc` for `project` only: when the Host's turn lease ends, in epoch milliseconds. */
  readonly leaseEndsAtMs: number | null;
}

/** The platform's record of one fetch invocation. `route` is the pattern the Worker logs, never the raw path. */
export interface Invocation {
  readonly atMs: number;
  readonly id: string;
  readonly route: string;
  readonly outcome: string;
  readonly wallTimeMs: number;
}

export interface LogData {
  readonly events: readonly AppEvent[];
  readonly invocations: readonly Invocation[];
  /** True when a query returned its row limit, so older rows may be missing. */
  readonly truncated: boolean;
}

/** Container CPU in one five-minute bucket, summed over the application's instances. */
export interface CpuBucket {
  readonly startMs: number;
  readonly cpuTimeSec: number;
}

/** Minutes the container was allocated in one five-minute bucket. */
export interface UsageBucket {
  readonly startMs: number;
  readonly runningMinutes: number;
}

export interface MetricData {
  readonly cpu: readonly CpuBucket[];
  readonly usage: readonly UsageBucket[];
}

/**
 * An instance the Containers API reports as running. `runningSinceMs` is when it entered that
 * state (`status.updated_at`), not when it was created (`started_at`): an instance created
 * hours earlier can be restarted, and only the running time counts against the idle limit.
 */
export interface RunningInstance {
  readonly id: string;
  readonly runningSinceMs: number;
}

export type Source<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "unavailable"; readonly reason: string };

/** Half-open time range in epoch milliseconds. */
export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface CheckInput {
  readonly worker: string;
  /** The time of the check. Metrics newer than a few minutes before it are incomplete. */
  readonly nowMs: number;
  readonly window: TimeWindow;
  readonly idleLimitMs: number;
  readonly logs: Source<LogData>;
  readonly metrics: Source<MetricData>;
  /** What the Containers API says is running at `window.toMs`, which metrics cannot yet tell. */
  readonly instances: Source<readonly RunningInstance[]>;
}

export type RuleId =
  | "slow-requests"
  | "poller"
  | "unowned-cpu"
  | "ran-past-idle"
  | "running-close"
  | "unexplained-stop"
  | "placement-unavailable"
  | "error-events"
  | "unknown";

export interface Finding {
  readonly rule: RuleId;
  /** Measured value against threshold, for example `38/h >= 10/h on /api/github/connection`. */
  readonly detail: string;
  /** Request ids, timestamps or bucket starts that let a reader find the raw data. */
  readonly evidence: readonly string[];
}

export const MINUTE_MS = 60_000;

export const HOUR_MS = 60 * MINUTE_MS;

export const BUCKET_MS = 5 * MINUTE_MS;
