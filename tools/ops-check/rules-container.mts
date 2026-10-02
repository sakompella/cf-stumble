/**
 * Rules c and d: container time that no owner work explains.
 *
 * Both compare container metrics against what the logs say the owner was doing. Work is placed on
 * the timeline as the span from when it started to when it was logged, because most events are
 * written when the work ends. A long exec therefore owns the buckets it ran through, even though
 * the log has one line at its end.
 */
import { firstIds, isoMinute } from "./evidence.mts";
import { coveredMs, mergeIntervals, touches, type Interval } from "./intervals.mts";
import type { Horizon } from "./horizon.mts";
import { activitySpans, isOwnerActivity, workSpans } from "./ownership.mts";
import {
  BUSY_CPU_SECONDS_PER_BUCKET,
  IDLE_OVERRUN_TOLERANCE_MS,
  UNOWNED_RUN_MS,
} from "./thresholds.mts";
import {
  BUCKET_MS,
  MINUTE_MS,
  type CpuBucket,
  type Finding,
  type RunningInstance,
  type LogData,
  type TimeWindow,
  type UsageBucket,
} from "./model.mts";

function bucketOf(startMs: number): Interval {
  return { beginMs: startMs, endMs: startMs + BUCKET_MS };
}

/** True for a bucket inside the window whose five minutes have fully reached the metrics. */
function usable(startMs: number, window: TimeWindow, horizon: Horizon): boolean {
  return inWindow(startMs, window) && startMs + BUCKET_MS <= horizon.completeUntilMs;
}

function inWindow(startMs: number, window: TimeWindow): boolean {
  return startMs >= window.fromMs - BUCKET_MS + 1 && startMs < window.toMs;
}

/** Split buckets, already sorted, into runs of buckets that follow one another exactly. */
function consecutiveRuns<T extends { readonly startMs: number }>(
  buckets: readonly T[],
): readonly (readonly T[])[] {
  const runs: T[][] = [];

  for (const bucket of buckets) {
    const run = runs.at(-1);

    if (run !== undefined && run.at(-1)?.startMs === bucket.startMs - BUCKET_MS) {
      run.push(bucket);
    } else {
      runs.push([bucket]);
    }
  }

  return runs;
}

export function unownedCpu(
  cpu: readonly CpuBucket[],
  logs: LogData,
  window: TimeWindow,
  horizon: Horizon,
): readonly Finding[] {
  const owned = mergeIntervals(workSpans(logs.events));

  const unowned = cpu
    .filter(
      (bucket) =>
        usable(bucket.startMs, window, horizon) &&
        bucket.cpuTimeSec > BUSY_CPU_SECONDS_PER_BUCKET &&
        !touches(bucketOf(bucket.startMs), owned),
    )
    .toSorted((a, b) => a.startMs - b.startMs);

  return consecutiveRuns(unowned).flatMap((run): Finding[] => {
    const runMs = run.length * BUCKET_MS;
    const cpuSeconds = run.reduce((sum, bucket) => sum + bucket.cpuTimeSec, 0);
    const first = run[0];

    if (runMs < UNOWNED_RUN_MS || first === undefined) {
      return [];
    }

    const vcpu = cpuSeconds / (runMs / 1000);

    return [
      {
        rule: "unowned-cpu",
        detail: `${runMs / MINUTE_MS} min >= ${UNOWNED_RUN_MS / MINUTE_MS} min above ${BUSY_CPU_SECONDS_PER_BUCKET} CPU-s per 5 min with no owner work, avg ${vcpu.toFixed(2)} vCPU`,
        evidence: firstIds([
          isoMinute(first.startMs),
          isoMinute(first.startMs + runMs - BUCKET_MS),
        ]),
      },
    ];
  });
}

/**
 * Time the owner may legitimately hold the container: each owner event's work, plus the idle
 * limit after it. Metrics buckets with allocated time outside this are running with nobody to
 * keep them up.
 */
function allowedRunning(logs: LogData, idleLimitMs: number): readonly Interval[] {
  const events = activitySpans(logs.events);

  const invocations = logs.invocations.map((invocation) => ({
    beginMs: invocation.atMs - invocation.wallTimeMs,
    endMs: invocation.atMs,
  }));

  return mergeIntervals(
    [...events, ...invocations].map((span) => ({ ...span, endMs: span.endMs + idleLimitMs })),
  );
}

/**
 * Instances the Containers API reports as running at the end of the window, measured directly
 * because the newest metrics are incomplete. Time the owner does not explain counts against the
 * instance from the start of the window, or from when it entered the running state if that is later.
 */
function runningNow(
  instances: readonly RunningInstance[],
  allowed: readonly Interval[],
  lastActivity: readonly number[],
  window: TimeWindow,
  idleLimitMs: number,
): readonly Finding[] {
  // An instance that began running after the window ended has a negative span here, so it never reports.
  return instances.flatMap((instance): Finding[] => {
    const span = {
      beginMs: Math.max(instance.runningSinceMs, window.fromMs),
      endMs: window.toMs,
    };

    const unexplainedMs = span.endMs - span.beginMs - coveredMs(span, allowed);

    const lastBefore = lastActivity
      .filter((atMs) => atMs < window.toMs)
      .toSorted((a, b) => b - a)[0];

    return unexplainedMs > IDLE_OVERRUN_TOLERANCE_MS
      ? [
          {
            rule: "ran-past-idle",
            detail: `${Math.round(unexplainedMs / MINUTE_MS)} min > ${IDLE_OVERRUN_TOLERANCE_MS / MINUTE_MS} min beyond the ${idleLimitMs / MINUTE_MS} min idle limit, instance still running, last owner activity ${lastBefore === undefined ? "none seen" : isoMinute(lastBefore)}`,
            evidence: firstIds([`instance:${instance.id.slice(0, 8)}`, isoMinute(window.toMs)]),
          },
        ]
      : [];
  });
}

export function ranPastIdle(
  usage: readonly UsageBucket[],
  instances: readonly RunningInstance[],
  logs: LogData,
  window: TimeWindow,
  idleLimitMs: number,
  horizon: Horizon,
): readonly Finding[] {
  const allowed = allowedRunning(logs, idleLimitMs);

  const running = usage
    .filter((bucket) => usable(bucket.startMs, window, horizon) && bucket.runningMinutes > 0)
    .toSorted((a, b) => a.startMs - b.startMs);

  const lastActivity = logs.events
    .filter((event) => isOwnerActivity(event))
    .map((event) => event.atMs);

  const now = horizon.live ? runningNow(instances, allowed, lastActivity, window, idleLimitMs) : [];

  const edgeMs = horizon.completeUntilMs - BUCKET_MS;

  const fromBuckets = consecutiveRuns(running).flatMap((run): Finding[] => {
    // A restart overlaps two instances, and a bucket can then report more minutes than it has.
    const excessMinutes = run.reduce(
      (sum, bucket) =>
        sum +
        Math.max(
          0,
          Math.min(bucket.runningMinutes, BUCKET_MS / MINUTE_MS) -
            coveredMs(bucketOf(bucket.startMs), allowed) / MINUTE_MS,
        ),
      0,
    );

    const first = run[0];

    if (excessMinutes * MINUTE_MS <= IDLE_OVERRUN_TOLERANCE_MS || first === undefined) {
      return [];
    }

    const runEndMs = first.startMs + run.length * BUCKET_MS;

    if (now.length > 0 && runEndMs > edgeMs) {
      return [];
    }

    const lastBefore = lastActivity.filter((atMs) => atMs < runEndMs).toSorted((a, b) => b - a)[0];

    return [
      {
        rule: "ran-past-idle",
        detail: `${Math.round(excessMinutes)} min > ${IDLE_OVERRUN_TOLERANCE_MS / MINUTE_MS} min beyond the ${idleLimitMs / MINUTE_MS} min idle limit, last owner activity ${lastBefore === undefined ? "none seen" : isoMinute(lastBefore)}`,
        evidence: firstIds([isoMinute(first.startMs), isoMinute(runEndMs)]),
      },
    ];
  });

  return [...now, ...fromBuckets];
}
