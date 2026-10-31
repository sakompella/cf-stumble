export const MINUTE_MS = 60_000;

export const BUCKET_MS = 5 * MINUTE_MS;

export const OVERRUN_SLACK_MS = 10 * MINUTE_MS;

export const METRICS_LAG_MS = 10 * MINUTE_MS;

const RECENT_REQUESTS = 3;

export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface Invocation {
  readonly endMs: number;
  readonly wallTimeMs: number;
  readonly route: string;
}

export interface UsageBucket {
  readonly startMs: number;
  readonly runningMinutes: number;
}

export interface Activity {
  readonly invocations: readonly Invocation[];
  readonly usage: readonly UsageBucket[];
}

export type Source<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "unavailable"; readonly reason: string };

export interface Finding {
  readonly rule: "ran-past-idle" | "unknown";
  readonly detail: string;
  readonly evidence: readonly string[];
}

export interface CheckInput {
  readonly worker: string;
  readonly nowMs: number;
  readonly window: TimeWindow;
  readonly idleLimitMs: number;
  readonly activity: Source<Activity>;
}

interface Span {
  readonly beginMs: number;
  readonly endMs: number;
}

function mergeSpans(spans: readonly Span[]): readonly Span[] {
  const merged: Span[] = [];

  for (const next of spans.toSorted((a, b) => a.beginMs - b.beginMs)) {
    const last = merged.at(-1);

    if (last !== undefined && next.beginMs <= last.endMs) {
      merged[merged.length - 1] = {
        beginMs: last.beginMs,
        endMs: Math.max(last.endMs, next.endMs),
      };
    } else {
      merged.push(next);
    }
  }

  return merged;
}

function coveredMs(span: Span, merged: readonly Span[]): number {
  return merged.reduce(
    (sum, other) =>
      sum + Math.max(0, Math.min(span.endMs, other.endMs) - Math.max(span.beginMs, other.beginMs)),
    0,
  );
}

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

function ranPastIdle(activity: Activity, input: CheckInput): readonly Finding[] {
  const { window, nowMs, idleLimitMs } = input;
  const { usage } = activity;
  const invocations = activity.invocations.filter((call) => call.route.startsWith("/api/"));
  const completeUntilMs = Math.min(window.toMs, nowMs - METRICS_LAG_MS);

  const allowed = mergeSpans(
    invocations.map((call) => ({
      beginMs: call.endMs - call.wallTimeMs,
      endMs: call.endMs + idleLimitMs,
    })),
  );

  const running = usage
    .filter(
      (bucket) =>
        bucket.runningMinutes > 0 &&
        bucket.startMs + BUCKET_MS > window.fromMs &&
        bucket.startMs + BUCKET_MS <= completeUntilMs,
    )
    .toSorted((a, b) => a.startMs - b.startMs);

  const runs = running.reduce<UsageBucket[][]>((all, bucket) => {
    const run = all.at(-1);

    if (run?.at(-1)?.startMs === bucket.startMs - BUCKET_MS) run.push(bucket);
    else all.push([bucket]);

    return all;
  }, []);

  return runs.flatMap((run): Finding[] => {
    const beginMs = run[0]?.startMs ?? 0;
    const endMs = (run.at(-1)?.startMs ?? 0) + BUCKET_MS;

    const overrunMinutes = run.reduce((sum, bucket) => {
      const bucketSpan = { beginMs: bucket.startMs, endMs: bucket.startMs + BUCKET_MS };
      const unallowed = Math.min(bucket.runningMinutes, BUCKET_MS / MINUTE_MS);

      return sum + Math.max(0, unallowed - coveredMs(bucketSpan, allowed) / MINUTE_MS);
    }, 0);

    if (overrunMinutes * MINUTE_MS <= OVERRUN_SLACK_MS) return [];

    const recent = invocations
      .filter((call) => call.endMs <= endMs)
      .toSorted((a, b) => b.endMs - a.endMs)
      .slice(0, RECENT_REQUESTS)
      .map((call) => `${call.route}@${isoMinute(call.endMs).slice(11)}`);

    return [
      {
        rule: "ran-past-idle",
        detail: `container ran ${isoMinute(beginMs)}..${isoMinute(endMs).slice(11)}, ${Math.round(overrunMinutes)} min > ${OVERRUN_SLACK_MS / MINUTE_MS} min beyond requests plus the ${idleLimitMs / MINUTE_MS} min idle limit`,
        evidence: recent.length === 0 ? ["no requests seen"] : recent,
      },
    ];
  });
}

export function runChecks(input: CheckInput): readonly Finding[] {
  return input.activity.status === "ok"
    ? ranPastIdle(input.activity.data, input)
    : [{ rule: "unknown", detail: input.activity.reason, evidence: [] }];
}

export function formatReport(input: CheckInput, findings: readonly Finding[]): readonly string[] {
  const { fromMs, toMs } = input.window;
  const label = `${isoMinute(fromMs)}..${isoMinute(toMs).slice(11)}`;

  return findings.length === 0
    ? [`✓ ops-check ${input.worker} ${label}`]
    : findings.map((finding) => {
        const evidence = finding.evidence.length === 0 ? "" : ` [${finding.evidence.join(" ")}]`;

        return `✗ ${finding.rule} ${finding.detail} ${label}${evidence}`;
      });
}
