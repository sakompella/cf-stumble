/**
 * Hand-made API responses for the incident tests, in the shapes the real APIs return.
 *
 * The data is invented: ids are counters, paths are routes, and no cookie, address or login
 * appears. Each scenario is parsed through the same code the CLI uses, so a change to a response
 * shape breaks a test here, not a live run.
 */
import type { JsonRecord, JsonValue } from "../browser-harness/json.mts";
import { BUCKET_MS, HOUR_MS, MINUTE_MS, type CheckInput, type TimeWindow } from "./model.mts";
import { parseMetrics, parseTelemetry } from "./parse.mts";

export const PROVISIONED_MEMORY_BYTES = 8 * 1024 ** 3;

export function at(iso: string): number {
  return Date.parse(iso);
}

export const WORKER = "cf-stumble";

export function logRow(atMs: number, source: JsonRecord, service = WORKER): JsonRecord {
  return {
    source,
    dataset: "cloudflare-workers",
    timestamp: atMs,
    $metadata: { requestId: "platform", service },
  };
}

export function eventRow(
  atMs: number,
  name: string,
  fields: JsonRecord = {},
  service = WORKER,
): JsonRecord {
  return logRow(atMs, { event: name, level: "info", ...fields }, service);
}

export function canceledInvocationRow(
  atMs: number,
  id: string,
  path: string,
  wallTimeMs: number,
  outcome = "canceled",
  service = WORKER,
): JsonRecord {
  return {
    source: { level: "info", message: `GET https://owner.example.test${path}` },
    timestamp: atMs,
    $workers: {
      eventType: "fetch",
      outcome,
      wallTimeMs,
      event: { request: { url: `https://owner.example.test${path}` } },
    },
    $metadata: { requestId: id, service },
  };
}

export function telemetry(rows: readonly JsonRecord[]): JsonValue {
  return { success: true, result: { events: { events: rows } } };
}

export function graphql(dataset: string, groups: readonly JsonRecord[]): JsonValue {
  return { data: { viewer: { accounts: [{ [dataset]: groups }] } } };
}

function group(startMs: number, sum: JsonRecord): JsonRecord {
  const dimensions = { datetimeFiveMinutes: new Date(startMs).toISOString(), applicationId: "app" };

  return { dimensions, sum };
}

/** Five-minute buckets across `[fromMs, toMs)`, each given its CPU-seconds by `cpuAt`. */
export function bucketsOf(
  window: TimeWindow,
  valueAt: (startMs: number) => number,
): readonly (readonly [number, number])[] {
  const count = Math.ceil((window.toMs - window.fromMs) / BUCKET_MS);

  return Array.from({ length: count }, (_, i) => {
    const startMs = window.fromMs + i * BUCKET_MS;

    return [startMs, valueAt(startMs)] as const;
  });
}

export function metrics(
  cpu: readonly (readonly [number, number])[],
  runningMinutes: readonly (readonly [number, number])[],
): CheckInput["metrics"] {
  return parseMetrics(
    graphql(
      "containersMetricsAdaptiveGroups",
      cpu.map(([t, cpuTimeSec]) => group(t, { cpuTimeSec })),
    ),
    graphql(
      "containersUsageAdaptiveGroups",
      runningMinutes.map(([t, minutes]) =>
        group(t, { allocatedMemory: minutes * 60 * PROVISIONED_MEMORY_BYTES }),
      ),
    ),
    PROVISIONED_MEMORY_BYTES,
  );
}

export function logs(
  events: readonly JsonRecord[],
  invocations: readonly JsonRecord[] = [],
): CheckInput["logs"] {
  return parseTelemetry(telemetry(events), telemetry(invocations), WORKER);
}

export function input(
  window: TimeWindow,
  sources: Pick<CheckInput, "logs" | "metrics"> & Partial<Pick<CheckInput, "instances">>,
): CheckInput {
  const none: CheckInput["instances"] = { status: "ok", data: [] };

  return { worker: WORKER, window, idleLimitMs: 20 * MINUTE_MS, instances: none, ...sources };
}

/**
 * 09-26: a browser polled `GET /api/github/connection` every 95 s. Each call ran a container
 * command, hit workspace-unavailable, and was canceled after 90 s. The container was busy, but
 * every busy minute was inside one of those calls.
 */
export function incident0926(): CheckInput {
  const window = { fromMs: at("2026-09-26T18:00:00Z"), toMs: at("2026-09-26T21:00:00Z") };

  const polls = Array.from(
    { length: Math.floor((3 * HOUR_MS) / 95_000) },
    (_, i) => window.fromMs + 95_000 * (i + 1),
  );

  const invocations = polls.map((t, i) =>
    canceledInvocationRow(t, `poll-${i}`, "/api/github/connection", 90_000),
  );

  const credential = polls.map((t) =>
    eventRow(t, "github-credential.status", {
      level: "warn",
      outcome: "threw",
      durationMs: 90_000,
    }),
  );

  const closed = [polls[10], polls[40]].map((t) =>
    eventRow(t ?? 0, "workspace.backend.closed", {
      level: "warn",
      running: true,
      reasonCode: "unknown",
    }),
  );

  return input(window, {
    logs: logs([...credential, ...closed], invocations),
    metrics: metrics(
      bucketsOf(window, () => 600),
      bucketsOf(window, () => 5),
    ),
  });
}

/**
 * 09-27: the container ran 19 hours at 0.6 to 1.0 vCPU after one request, with flat memory and
 * four log events. Nothing in the logs owns the CPU, and the stop has no known reason.
 */
export function incident0927(extraRows: readonly JsonRecord[] = []): CheckInput {
  const window = { fromMs: at("2026-09-27T00:00:00Z"), toMs: at("2026-09-27T19:00:00Z") };

  const events = [
    eventRow(at("2026-09-27T00:01:00Z"), "workspace.container.started", { runtimeId: "run-1" }),
    eventRow(at("2026-09-27T00:02:00Z"), "route.settled", {
      requestId: "req-1",
      route: "/api/projects",
      durationMs: 300,
    }),
    eventRow(at("2026-09-27T00:02:00Z"), "workspace.rpc", { requestId: "req-1", durationMs: 250 }),
    eventRow(at("2026-09-27T18:56:00Z"), "workspace.container.stopped", {
      level: "warn",
      reasonCode: "unknown",
    }),
  ];

  const running = { fromMs: at("2026-09-27T00:00:00Z"), toMs: at("2026-09-27T18:55:00Z") };
  const cpu = bucketsOf(running, (t) => 180 + ((t / BUCKET_MS) % 5) * 30);

  return input(window, {
    logs: logs([...events, ...extraRows]),
    metrics: metrics(
      cpu,
      bucketsOf(running, () => 5),
    ),
  });
}

/** One owner request at 09:00 starts a 4-minute turn. The container idles 20 minutes, then stops. */
export function healthyDay(extraRows: readonly JsonRecord[] = []): CheckInput {
  const window = { fromMs: at("2026-09-30T00:00:00Z"), toMs: at("2026-10-01T00:00:00Z") };
  const turnEnd = at("2026-09-30T09:04:00Z");

  const events = [
    eventRow(at("2026-09-30T09:00:00Z"), "route.settled", {
      requestId: "req-a",
      route: "/api/projects",
      durationMs: 400,
    }),
    eventRow(at("2026-09-30T09:00:00Z"), "workspace.rpc", { requestId: "req-a", durationMs: 350 }),
    eventRow(turnEnd, "turn.settled", { totalMs: 4 * MINUTE_MS, ending: "saved" }),
    eventRow(at("2026-09-30T09:24:00Z"), "workspace.container.stopped", { reasonCode: "idle" }),
  ];

  const active = { fromMs: at("2026-09-30T09:00:00Z"), toMs: at("2026-09-30T09:25:00Z") };
  const cpu = bucketsOf(active, (t) => (t < turnEnd ? 90 : 4));

  return input(window, {
    logs: logs([...events, ...extraRows]),
    metrics: metrics(
      cpu,
      bucketsOf(active, (t) => (t < at("2026-09-30T09:20:00Z") ? 5 : 4)),
    ),
  });
}

/** The healthy day's logs with metrics that returned no rows at all. */
export function missingMetricsDay(): CheckInput {
  return { ...healthyDay(), metrics: metrics([], []) };
}

/**
 * What a staging copy of the Worker writes on the same account during `window`: faults, an
 * unexplained stop, and workspace work around the clock. None of it belongs to `cf-stumble`.
 */
export function stagingWorkerRows(window: TimeWindow): readonly JsonRecord[] {
  const staging = "cf-stumble-staging";
  const at5 = (minutes: number) => window.fromMs + minutes * MINUTE_MS;

  const around = Array.from(
    { length: Math.ceil((window.toMs - window.fromMs) / BUCKET_MS) },
    (_, i) => eventRow(at5(i * 5 + 4), "workspace.exec", { durationMs: 4 * MINUTE_MS }, staging),
  );

  return [
    ...around,
    eventRow(at5(1), "workspace.backend.closed", { level: "warn", running: true }, staging),
    eventRow(
      at5(2),
      "workspace.container.stopped",
      { level: "warn", reasonCode: "unknown" },
      staging,
    ),
    eventRow(
      at5(3),
      "route.settled",
      { level: "error", requestId: "s", route: "/api/x", durationMs: 1 },
      staging,
    ),
  ];
}
