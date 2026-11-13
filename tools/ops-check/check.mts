import { routeClass } from "../../src/routes/route-pattern.ts";
import { PROJECT_RUN_DEADLINE_MS } from "../../src/turn-budget.ts";

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

export interface SessionFailure {
  readonly atMs: number;
  readonly cause: string;
}

export interface RunSettlement {
  readonly atMs: number;
  readonly totalMs: number;
}

export interface ModelCall {
  readonly provider: string;
  readonly promptTokens: number;
  readonly cachedTokens: number;
}

export interface ModelCalls {
  readonly calls: readonly ModelCall[];
  readonly sample: boolean;
}

export interface Activity {
  readonly invocations: readonly Invocation[];
  readonly usage: readonly UsageBucket[];
  readonly sessionFailures: readonly SessionFailure[];
  readonly runStarts: readonly number[];
  readonly runSettlements: readonly RunSettlement[];
}

export type Source<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "unavailable"; readonly reason: string };

export interface Finding {
  readonly rule: "ran-past-idle" | "facet.session-failed" | "do-version-skew" | "unknown";
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

export function activityWindow(window: TimeWindow, idleLimitMs: number): TimeWindow {
  const firstBucketMs = Math.floor(window.fromMs / BUCKET_MS) * BUCKET_MS;

  return { fromMs: firstBucketMs - PROJECT_RUN_DEADLINE_MS - idleLimitMs, toMs: window.toMs };
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

function describeCall(call: Invocation): string {
  return `${call.route}@${isoMinute(call.endMs).slice(11)}`;
}

function completeUntilMs(input: CheckInput): number {
  return Math.min(input.window.toMs, input.nowMs - METRICS_LAG_MS);
}

function allowedSpans(
  activity: Activity,
  workspaceCalls: readonly Invocation[],
  idleLimitMs: number,
): readonly Span[] {
  return mergeSpans([
    ...activity.runStarts.map((startedMs) => ({
      beginMs: startedMs,
      endMs: startedMs + PROJECT_RUN_DEADLINE_MS + idleLimitMs,
    })),
    ...activity.runSettlements.map((settlement) => ({
      beginMs: settlement.atMs - settlement.totalMs,
      endMs: settlement.atMs + idleLimitMs,
    })),
    ...workspaceCalls.map((call) => ({
      beginMs: call.endMs - call.wallTimeMs,
      endMs: call.endMs + idleLimitMs,
    })),
  ]);
}

function ranPastIdle(activity: Activity, input: CheckInput): readonly Finding[] {
  const { window, idleLimitMs } = input;
  const { usage } = activity;
  const apiCalls = activity.invocations.filter((call) => call.route.startsWith("/api/"));
  const workspaceCalls = apiCalls.filter((call) => routeClass(call.route) === "workspace");
  const allowed = allowedSpans(activity, workspaceCalls, idleLimitMs);

  const running = usage
    .filter(
      (bucket) =>
        bucket.runningMinutes > 0 &&
        bucket.startMs >= window.fromMs &&
        bucket.startMs + BUCKET_MS <= completeUntilMs(input),
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

    const recent = apiCalls
      .filter((call) => call.endMs <= endMs)
      .toSorted((a, b) => b.endMs - a.endMs)
      .slice(0, RECENT_REQUESTS)
      .map(describeCall);

    return [
      {
        rule: "ran-past-idle",
        detail: `container ran ${isoMinute(beginMs)}..${isoMinute(endMs).slice(11)}, ${Math.round(overrunMinutes)} min > ${OVERRUN_SLACK_MS / MINUTE_MS} min beyond requests plus the ${idleLimitMs / MINUTE_MS} min idle limit`,
        evidence: recent.length === 0 ? ["no requests seen"] : recent,
      },
    ];
  });
}

function sessionFailed(activity: Activity): readonly Finding[] {
  const [first] = activity.sessionFailures;

  if (first === undefined) return [];

  return [
    {
      rule: "facet.session-failed",
      detail: `${activity.sessionFailures.length} facet session failure(s); first: ${first.cause}`,
      evidence: activity.sessionFailures.slice(0, 3).map((failure) => isoMinute(failure.atMs)),
    },
  ];
}

export function runChecks(input: CheckInput): readonly Finding[] {
  if (input.activity.status !== "ok") {
    return [{ rule: "unknown", detail: input.activity.reason, evidence: [] }];
  }

  const failures = sessionFailed(input.activity.data);

  if (completeUntilMs(input) <= input.window.fromMs) {
    return [
      {
        rule: "unknown",
        detail: `usage lags ${METRICS_LAG_MS / MINUTE_MS} min, so none of this window is complete yet; widen --since or wait`,
        evidence: [],
      },
      ...failures,
    ];
  }

  return [...failures, ...ranPastIdle(input.activity.data, input)];
}

function providerLine(provider: string, calls: readonly ModelCall[], sample: boolean): string {
  const prompt = calls.reduce((sum, call) => sum + call.promptTokens, 0);
  const cached = calls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const rate = prompt === 0 ? "n/a" : `${((100 * cached) / prompt).toFixed(1)}%`;

  return `i model calls ${provider}: ${calls.length}, cache hit rate ${rate} (${cached}/${prompt} prompt tokens${sample ? ", a sample: telemetry returned its row limit, use a shorter --since for all" : ""})`;
}

export function modelCallLines({ calls, sample }: ModelCalls): readonly string[] {
  const providers = [...new Set(calls.map((call) => call.provider))].toSorted();

  return providers.map((provider) =>
    providerLine(
      provider,
      calls.filter((call) => call.provider === provider),
      sample,
    ),
  );
}

export function formatReport(
  input: CheckInput,
  findings: readonly Finding[],
  modelCalls: ModelCalls | null,
): readonly string[] {
  return [
    ...reportFindings(input, findings),
    ...(modelCalls === null ? [] : modelCallLines(modelCalls)),
  ];
}

function reportFindings(input: CheckInput, findings: readonly Finding[]): readonly string[] {
  const label = `${isoMinute(input.window.fromMs)}..${isoMinute(completeUntilMs(input)).slice(11)}`;

  return findings.length === 0
    ? [`✓ ops-check ${input.worker} ${label}`]
    : findings.map((finding) => {
        const evidence = finding.evidence.length === 0 ? "" : ` [${finding.evidence.join(" ")}]`;

        return `✗ ${finding.rule} ${finding.detail} ${label}${evidence}`;
      });
}
