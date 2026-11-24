import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { routePattern } from "../../src/routes/route-pattern.ts";
import { ApiFailure, sendToAccount, type Account } from "./fetch.mts";
import type {
  Invocation,
  ModelCalls,
  RunSettlement,
  SessionFailure,
  TimeWindow,
} from "./check.mts";

const TELEMETRY_ROW_LIMIT = 2000;

const RUN_STARTED_EVENT = "run.started";

const RUN_SETTLED_EVENT = "run.settled";

const SESSION_FAILED_EVENT = "facet.session-failed";

const MODEL_CALL_EVENTS = { "model.call": "workers-ai", "chatgpt.model-call": "chatgpt" } as const;

type ModelCallEvent = keyof typeof MODEL_CALL_EVENTS;

export type Filter = Readonly<{ key: string; operation: "eq" | "neq"; value: string }>;

const TelemetryEnvelope = Schema.Struct({
  result: Schema.Struct({ events: Schema.Struct({ events: Schema.Array(Schema.Json) }) }),
});

const WallTimeRow = Schema.Struct({
  $workers: Schema.Struct({ wallTimeMs: Schema.Number }),
});

const InvocationRow = Schema.Struct({
  timestamp: Schema.Number,
  $workers: Schema.Struct({
    wallTimeMs: Schema.Number,
    event: Schema.Struct({ request: Schema.Struct({ url: Schema.String }) }),
  }),
});

const RunEventRow = Schema.Struct({
  timestamp: Schema.Number,
  source: Schema.Struct({ event: Schema.String }),
});

const SettlementRow = Schema.Struct({
  timestamp: Schema.Number,
  source: Schema.Struct({ event: Schema.String, totalMs: Schema.optional(Schema.Number) }),
});

const SessionFailureRow = Schema.Struct({
  timestamp: Schema.Number,
  source: Schema.Struct({ event: Schema.String, cause: Schema.optional(Schema.String) }),
});

const ModelCallRow = Schema.Struct({
  source: Schema.Struct({
    event: Schema.String,
    promptTokens: Schema.Number,
    cachedTokens: Schema.optional(Schema.Number),
  }),
});

const decodeOption = Schema.decodeUnknownOption;

export function pageRows(response: Schema.Json) {
  const rows = decodeOption(TelemetryEnvelope)(response);

  if (Option.isNone(rows)) {
    throw new ApiFailure("telemetry response had an unexpected shape");
  }

  const events = rows.value.result.events.events;

  return { rows: events, sample: events.length >= TELEMETRY_ROW_LIMIT };
}

export function eventRows(response: Schema.Json): readonly Schema.Json[] {
  const { rows, sample } = pageRows(response);

  if (sample) {
    throw new ApiFailure(
      `telemetry returned ${TELEMETRY_ROW_LIMIT} rows, the most it gives; narrow the window`,
    );
  }

  return rows;
}

export function parseInvocations(response: Schema.Json): readonly Invocation[] {
  return eventRows(response).flatMap((row) => {
    if (Option.isNone(decodeOption(WallTimeRow)(row))) return [];

    const parsed = Schema.decodeUnknownResult(InvocationRow)(row);

    if (Result.isFailure(parsed)) throw new ApiFailure("telemetry row had an unexpected shape");

    const { timestamp, $workers } = parsed.success;

    return [
      {
        endMs: timestamp,
        wallTimeMs: $workers.wallTimeMs,
        route: routePattern(
          URL.parse($workers.event.request.url)?.pathname ?? $workers.event.request.url,
        ),
      },
    ];
  });
}

function parseRunStarts(response: Schema.Json): readonly number[] {
  return eventRows(response).flatMap((row) => {
    const parsed = decodeOption(RunEventRow)(row);

    return Option.isSome(parsed) && parsed.value.source.event === RUN_STARTED_EVENT
      ? [parsed.value.timestamp]
      : [];
  });
}

function parseRunSettlements(response: Schema.Json): readonly RunSettlement[] {
  return eventRows(response).flatMap((row) => {
    const parsed = decodeOption(SettlementRow)(row);

    return Option.isSome(parsed) && parsed.value.source.event === RUN_SETTLED_EVENT
      ? [{ atMs: parsed.value.timestamp, totalMs: parsed.value.source.totalMs ?? 0 }]
      : [];
  });
}

export function parseSessionFailures(response: Schema.Json): readonly SessionFailure[] {
  return eventRows(response).flatMap((row) => {
    const parsed = decodeOption(SessionFailureRow)(row);

    return Option.isSome(parsed) && parsed.value.source.event === SESSION_FAILED_EVENT
      ? [{ atMs: parsed.value.timestamp, cause: parsed.value.source.cause ?? "no cause" }]
      : [];
  });
}

export function parseModelCalls(response: Schema.Json, event: ModelCallEvent): ModelCalls {
  const { rows, sample } = pageRows(response);

  const calls = rows.flatMap((row) => {
    const parsed = decodeOption(ModelCallRow)(row);

    return Option.isSome(parsed) && parsed.value.source.event === event
      ? [
          {
            provider: MODEL_CALL_EVENTS[event],
            promptTokens: parsed.value.source.promptTokens,
            cachedTokens: parsed.value.source.cachedTokens ?? 0,
          },
        ]
      : [];
  });

  return { calls, sample };
}

export function queryTelemetry(
  account: Account,
  worker: string,
  window: TimeWindow,
  filters: readonly Filter[],
  needle?: string,
): Promise<Schema.Json> {
  const allFilters = [{ key: "$metadata.service", operation: "eq", value: worker }, ...filters].map(
    (filter) => ({ ...filter, type: "string" }),
  );

  return sendToAccount(account, "/workers/observability/telemetry/query", {
    queryId: "adhoc",
    view: "events",
    dry: true,
    limit: TELEMETRY_ROW_LIMIT,
    timeframe: { from: window.fromMs, to: window.toMs },
    parameters:
      needle === undefined
        ? { filters: allFilters }
        : { filters: allFilters, needle: { value: needle, matchCase: true, isRegex: false } },
  });
}

export function queryEvents(
  account: Account,
  worker: string,
  window: TimeWindow,
  event: string,
): Promise<Schema.Json> {
  return queryTelemetry(account, worker, window, [], event);
}

export async function fetchInvocations(
  account: Account,
  worker: string,
  window: TimeWindow,
): Promise<readonly Invocation[]> {
  return parseInvocations(
    await queryTelemetry(account, worker, window, [
      { key: "$workers.eventType", operation: "eq", value: "fetch" },
    ]),
  );
}

export async function fetchRunStarts(
  account: Account,
  worker: string,
  window: TimeWindow,
): Promise<readonly number[]> {
  return parseRunStarts(await queryEvents(account, worker, window, RUN_STARTED_EVENT));
}

export async function fetchRunSettlements(
  account: Account,
  worker: string,
  window: TimeWindow,
): Promise<readonly RunSettlement[]> {
  return parseRunSettlements(await queryEvents(account, worker, window, RUN_SETTLED_EVENT));
}

export async function fetchSessionFailures(
  account: Account,
  worker: string,
  window: TimeWindow,
): Promise<readonly SessionFailure[]> {
  return parseSessionFailures(await queryEvents(account, worker, window, SESSION_FAILED_EVENT));
}

export async function fetchModelCalls(
  account: Account,
  worker: string,
  window: TimeWindow,
): Promise<ModelCalls> {
  const events: readonly ModelCallEvent[] = ["model.call", "chatgpt.model-call"];

  const pages = await Promise.all(
    events.map(async (event) =>
      parseModelCalls(await queryEvents(account, worker, window, event), event),
    ),
  );

  return {
    calls: pages.flatMap((page) => page.calls),
    sample: pages.some((page) => page.sample),
  };
}
