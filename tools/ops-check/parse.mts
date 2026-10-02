/**
 * Parse Cloudflare API responses into the typed models. Everything that reads a raw field lives
 * here. A response of an unexpected shape becomes an `unavailable` source with a reason; a field
 * a row lacks becomes `null`, never a guess.
 */
import {
  isJsonArray,
  isJsonNumber,
  isJsonRecord,
  isJsonString,
  type JsonRecord,
  type JsonValue,
} from "../browser-harness/json.mts";
import { TELEMETRY_ROW_LIMIT } from "./thresholds.mts";
import type {
  AppEvent,
  CpuBucket,
  EventLevel,
  Invocation,
  LogData,
  MetricData,
  Source,
  UsageBucket,
} from "./model.mts";

function unavailable<T>(reason: string): Source<T> {
  return { status: "unavailable", reason };
}

function member(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== undefined && isJsonRecord(value) ? value[key] : undefined;
}

function path(value: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined {
  return keys.reduce<JsonValue | undefined>((current, key) => member(current, key), value);
}

function text(value: JsonValue | undefined): string | null {
  return value !== undefined && isJsonString(value) ? value : null;
}

function number(value: JsonValue | undefined): number | null {
  return value !== undefined && isJsonNumber(value) ? value : null;
}

function level(value: JsonValue | undefined): EventLevel {
  const name = text(value);

  return name === "info" || name === "warn" || name === "error" ? name : "other";
}

function parseAppEvent(row: JsonRecord, source: JsonRecord): AppEvent | null {
  const name = text(source["event"]);
  const atMs = number(row["timestamp"]);

  if (name === null || atMs === null) {
    return null;
  }

  const running = source["running"];

  return {
    atMs,
    name,
    level: level(source["level"]),
    requestId: text(source["requestId"]),
    spanMs:
      number(source["durationMs"]) ?? number(source["totalMs"]) ?? number(source["elapsedMs"]) ?? 0,
    route: text(source["route"]),
    applicationOutcome: text(source["applicationOutcome"]),
    running: running === true || running === false ? running : null,
    reasonCode: text(source["reasonCode"]),
  };
}

function parseInvocation(row: JsonRecord): Invocation | null {
  const workers = row["$workers"];
  const url = text(path(workers, ["event", "request", "url"]));
  const atMs = number(row["timestamp"]);
  const outcome = text(member(workers, "outcome"));
  const wallTimeMs = number(member(workers, "wallTimeMs"));
  const id = text(path(row, ["$metadata", "requestId"]));

  if (text(member(workers, "eventType")) !== "fetch") {
    return null;
  }

  if (url === null || atMs === null || outcome === null || wallTimeMs === null || id === null) {
    return null;
  }

  return { atMs, id, route: URL.parse(url)?.pathname ?? url, outcome, wallTimeMs };
}

/** Rows of one telemetry `events` view response, or `null` when the shape is wrong. */
function telemetryRows(response: JsonValue): readonly JsonRecord[] | null {
  const rows = path(response, ["result", "events", "events"]);

  return rows !== undefined && isJsonArray(rows) ? rows.filter((row) => isJsonRecord(row)) : null;
}

/**
 * Rows written by `worker`. The query asks for that already; checking again here means a row from
 * another Worker on the account (a staging copy, an e2e Worker) can never reach a rule even if the
 * query filter is lost.
 */
function ownedBy(worker: string, rows: readonly JsonRecord[]): readonly JsonRecord[] {
  return rows.filter((row) => text(path(row, ["$metadata", "service"])) === worker);
}

/**
 * Combine the two telemetry queries: every row with an `event` field, and every canceled
 * invocation. `truncated` is true when either query hit the row limit.
 */
export function parseTelemetry(
  eventsResponse: JsonValue,
  invocationsResponse: JsonValue,
  worker: string,
): Source<LogData> {
  const eventRows = telemetryRows(eventsResponse);
  const invocationRows = telemetryRows(invocationsResponse);

  if (eventRows === null || invocationRows === null) {
    return unavailable("telemetry response had an unexpected shape");
  }

  return {
    status: "ok",
    data: {
      events: ownedBy(worker, eventRows).flatMap((row) => {
        const source = row["source"];

        const event =
          source !== undefined && isJsonRecord(source) ? parseAppEvent(row, source) : null;

        return event === null ? [] : [event];
      }),
      invocations: ownedBy(worker, invocationRows).flatMap((row) => {
        const invocation = parseInvocation(row);

        return invocation === null ? [] : [invocation];
      }),
      truncated: [eventRows, invocationRows].some((rows) => rows.length >= TELEMETRY_ROW_LIMIT),
    },
  };
}

function graphqlGroups(response: JsonValue, dataset: string): readonly JsonRecord[] | null {
  const errors = member(response, "errors");

  if (errors !== undefined && errors !== null && isJsonArray(errors) && errors.length > 0) {
    return null;
  }

  const groups = path(response, ["data", "viewer", "accounts"]);
  const account = groups !== undefined && isJsonArray(groups) ? groups[0] : undefined;
  const rows = member(account, dataset);

  return rows !== undefined && isJsonArray(rows) ? rows.filter((row) => isJsonRecord(row)) : null;
}

function bucketStart(row: JsonRecord): number | null {
  const iso = text(path(row, ["dimensions", "datetimeFiveMinutes"]));
  const ms = iso === null ? Number.NaN : Date.parse(iso);

  return Number.isNaN(ms) ? null : ms;
}

/** Sum rows that share a bucket, because an application can report several instances. */
function sumByBucket(pairs: readonly (readonly [number, number])[]): ReadonlyMap<number, number> {
  const sums = new Map<number, number>();

  for (const [startMs, value] of pairs) {
    sums.set(startMs, (sums.get(startMs) ?? 0) + value);
  }

  return sums;
}

export function parseMetrics(
  metricsResponse: JsonValue,
  usageResponse: JsonValue,
  provisionedMemoryBytes: number,
): Source<MetricData> {
  const metricRows = graphqlGroups(metricsResponse, "containersMetricsAdaptiveGroups");
  const usageRows = graphqlGroups(usageResponse, "containersUsageAdaptiveGroups");

  if (metricRows === null || usageRows === null) {
    return unavailable("GraphQL response had errors or an unexpected shape");
  }

  const pairs = (rows: readonly JsonRecord[], group: string, field: string) =>
    rows.flatMap((row): (readonly [number, number])[] => {
      const startMs = bucketStart(row);
      const value = number(path(row, [group, field]));

      return startMs === null || value === null ? [] : [[startMs, value]];
    });

  const cpu: readonly CpuBucket[] = [...sumByBucket(pairs(metricRows, "sum", "cpuTimeSec"))].map(
    ([startMs, cpuTimeSec]) => ({ startMs, cpuTimeSec }),
  );

  const usage: readonly UsageBucket[] = [
    ...sumByBucket(pairs(usageRows, "sum", "allocatedMemory")),
  ].map(([startMs, byteSeconds]) => ({
    startMs,
    runningMinutes: byteSeconds / provisionedMemoryBytes / 60,
  }));

  return { status: "ok", data: { cpu, usage } };
}

export interface ContainerApplication {
  readonly id: string;
  readonly name: string;
  readonly memoryBytes: number;
}

/** The container applications of an account, from the Containers API list response. */
export function parseApplications(response: JsonValue): readonly ContainerApplication[] | null {
  const result = member(response, "result");

  if (result === undefined || !isJsonArray(result)) {
    return null;
  }

  return result.flatMap((application): ContainerApplication[] => {
    const id = text(member(application, "id"));
    const name = text(member(application, "name"));
    const mebibytes = number(path(application, ["configuration", "memory_mib"]));

    return id === null || name === null || mebibytes === null
      ? []
      : [{ id, name, memoryBytes: mebibytes * 1024 * 1024 }];
  });
}
