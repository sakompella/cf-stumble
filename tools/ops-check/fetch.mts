import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  durableObjectClasses,
  WORKSPACE_CONTAINER_MEMORY_MIB,
} from "../../infra/worker-settings.ts";
import { routePattern } from "../../src/routes/route-pattern.ts";
import {
  isJsonArray,
  isJsonNumber,
  isJsonRecord,
  isJsonString,
  parseJsonRecordText,
  parseJsonText,
  type JsonRecord,
  type JsonValue,
} from "../json.mts";
import {
  BUCKET_MS,
  type Invocation,
  type ModelCalls,
  type RunSettlement,
  type SessionFailure,
  type TimeWindow,
  type UsageBucket,
} from "./check.mts";

const API = "https://api.cloudflare.com/client/v4";

const TELEMETRY_ROW_LIMIT = 2000;

const METRICS_ROW_LIMIT = 5000;

export class ApiFailure extends Error {}

function dig(value: JsonValue | undefined, ...keys: readonly string[]) {
  return keys.reduce<JsonValue | undefined>(
    (current, key) => (current !== undefined && isJsonRecord(current) ? current[key] : undefined),
    value,
  );
}

function digString(value: JsonValue | undefined, ...keys: readonly string[]) {
  const found = dig(value, ...keys);

  return found !== undefined && isJsonString(found) ? found : null;
}

function digNumber(value: JsonValue | undefined, ...keys: readonly string[]) {
  const found = dig(value, ...keys);

  return found !== undefined && isJsonNumber(found) ? found : null;
}

function digArray(value: JsonValue | undefined, ...keys: readonly string[]) {
  const found = dig(value, ...keys);

  return found !== undefined && isJsonArray(found) ? found : null;
}

const CF_LOGIN_FILE = join(homedir(), ".config", "cloudflare", "config", "default.json");

export function readToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["CLOUDFLARE_API_TOKEN"]?.trim() ?? "";

  if (fromEnv !== "") return fromEnv;

  let login: JsonRecord | undefined;

  try {
    login = parseJsonRecordText(readFileSync(CF_LOGIN_FILE, "utf8"));
  } catch {
    login = undefined;
  }

  const token = login === undefined ? null : digString(login, "oauth_token");

  if (token === null || token === "") {
    throw new ApiFailure(`no CLOUDFLARE_API_TOKEN and no cf login in ${CF_LOGIN_FILE}`);
  }

  return token;
}

async function send(token: string, url: string, body?: JsonRecord): Promise<JsonValue> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

  if (!response.ok) {
    throw new ApiFailure(`HTTP ${response.status} from ${new URL(url).pathname}`);
  }

  return parseJsonText(await response.text().catch(() => "")) ?? null;
}

export async function resolveAccount(token: string, env: NodeJS.ProcessEnv): Promise<string> {
  const named = env["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";

  if (named !== "") return named;

  const accounts = digArray(await send(token, `${API}/accounts`), "result") ?? [];
  const ids = accounts.flatMap((account) => digString(account, "id") ?? []);

  if (ids.length !== 1 || ids[0] === undefined) {
    throw new ApiFailure(`token sees ${ids.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
  }

  return ids[0];
}

export function parseInvocations(response: JsonValue): readonly Invocation[] {
  return eventRows(response).flatMap((row) => {
    const wallTimeMs = digNumber(row, "$workers", "wallTimeMs");

    if (wallTimeMs === null) return [];

    const endMs = digNumber(row, "timestamp");
    const url = digString(row, "$workers", "event", "request", "url");

    if (endMs === null || url === null) {
      throw new ApiFailure("telemetry row had an unexpected shape");
    }

    return [{ endMs, wallTimeMs, route: routePattern(URL.parse(url)?.pathname ?? url) }];
  });
}

export async function fetchInvocations(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly Invocation[]> {
  const response = await send(
    token,
    `${API}/accounts/${account}/workers/observability/telemetry/query`,
    {
      queryId: "adhoc",
      view: "events",
      dry: true,
      limit: TELEMETRY_ROW_LIMIT,
      timeframe: { from: window.fromMs, to: window.toMs },
      parameters: {
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: worker },
          { key: "$workers.eventType", operation: "eq", type: "string", value: "fetch" },
        ],
      },
    },
  );

  return parseInvocations(response);
}

const RUN_STARTED_EVENT = "run.started";

const RUN_SETTLED_EVENT = "run.settled";

function eventRows(response: JsonValue): readonly JsonValue[] {
  const rows = digArray(response, "result", "events", "events");

  if (rows === null) throw new ApiFailure("telemetry response had an unexpected shape");

  if (rows.length >= TELEMETRY_ROW_LIMIT) {
    throw new ApiFailure(
      `telemetry returned ${TELEMETRY_ROW_LIMIT} rows, the most it gives; use a shorter --since`,
    );
  }

  return rows;
}

export function parseRunStarts(response: JsonValue): readonly number[] {
  return eventRows(response).flatMap((row) => {
    const atMs = digNumber(row, "timestamp");

    return digString(row, "source", "event") === RUN_STARTED_EVENT && atMs !== null ? [atMs] : [];
  });
}

export function parseRunSettlements(response: JsonValue): readonly RunSettlement[] {
  return eventRows(response).flatMap((row) => {
    const atMs = digNumber(row, "timestamp");

    if (digString(row, "source", "event") !== RUN_SETTLED_EVENT || atMs === null) return [];

    return [{ atMs, totalMs: digNumber(row, "source", "totalMs") ?? 0 }];
  });
}

export async function fetchRunStarts(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly number[]> {
  return parseRunStarts(await queryEvents(token, account, worker, window, RUN_STARTED_EVENT));
}

export async function fetchRunSettlements(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly RunSettlement[]> {
  return parseRunSettlements(await queryEvents(token, account, worker, window, RUN_SETTLED_EVENT));
}

const SESSION_FAILED_EVENT = "facet.session-failed";

export function parseSessionFailures(response: JsonValue): readonly SessionFailure[] {
  return eventRows(response).flatMap((row) => {
    const atMs = digNumber(row, "timestamp");

    if (digString(row, "source", "event") !== SESSION_FAILED_EVENT || atMs === null) return [];

    return [{ atMs, cause: digString(row, "source", "cause") ?? "no cause" }];
  });
}

const MODEL_CALL_EVENT = "model.call";

export function parseModelCalls(response: JsonValue): ModelCalls {
  const rows = digArray(response, "result", "events", "events");

  if (rows === null) throw new ApiFailure("telemetry response had an unexpected shape");

  const calls = rows.flatMap((row) => {
    const promptTokens = digNumber(row, "source", "promptTokens");
    const cachedTokens = digNumber(row, "source", "cachedTokens");

    if (digString(row, "source", "event") !== MODEL_CALL_EVENT) return [];

    return promptTokens === null ? [] : [{ promptTokens, cachedTokens: cachedTokens ?? 0 }];
  });

  return { calls, sample: rows.length >= TELEMETRY_ROW_LIMIT };
}

function eventQuery(worker: string, window: TimeWindow, event: string): JsonRecord {
  return {
    queryId: "adhoc",
    view: "events",
    dry: true,
    limit: TELEMETRY_ROW_LIMIT,
    timeframe: { from: window.fromMs, to: window.toMs },
    parameters: {
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
      needle: { value: event, matchCase: true, isRegex: false },
    },
  };
}

export async function fetchModelCalls(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<ModelCalls> {
  return parseModelCalls(await queryEvents(token, account, worker, window, MODEL_CALL_EVENT));
}

function queryEvents(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
  event: string,
): Promise<JsonValue> {
  return send(
    token,
    `${API}/accounts/${account}/workers/observability/telemetry/query`,
    eventQuery(worker, window, event),
  );
}

export async function fetchSessionFailures(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly SessionFailure[]> {
  return parseSessionFailures(
    await queryEvents(token, account, worker, window, SESSION_FAILED_EVENT),
  );
}

export function parseUsage(response: JsonValue, memoryBytes: number): readonly UsageBucket[] {
  const account = digArray(response, "data", "viewer", "accounts")?.[0];
  const rows = digArray(account, "containersUsageAdaptiveGroups");

  const errors = digArray(response, "errors");

  if ((errors !== null && errors.length > 0) || rows === null) {
    throw new ApiFailure("GraphQL response had errors or an unexpected shape");
  }

  if (rows.length >= METRICS_ROW_LIMIT) {
    throw new ApiFailure("GraphQL usage reached its row limit; use a shorter --since");
  }

  const byteSeconds = new Map<number, number>();

  for (const row of rows) {
    const bucket = digString(row, "dimensions", "datetimeFiveMinutes");
    const value = digNumber(row, "sum", "allocatedMemory");
    const startMs = bucket === null ? Number.NaN : Date.parse(bucket);

    if (Number.isNaN(startMs) || value === null) {
      throw new ApiFailure("GraphQL usage row had an unexpected shape");
    }

    byteSeconds.set(startMs, (byteSeconds.get(startMs) ?? 0) + value);
  }

  return [...byteSeconds].map(([startMs, total]) => ({
    startMs,
    runningMinutes: total / memoryBytes / 60,
  }));
}

const USAGE_QUERY = `query($a:String!,$f:Time!,$t:Time!,$apps:[string!]){viewer{accounts(filter:{accountTag:$a}){
  containersUsageAdaptiveGroups(limit:${METRICS_ROW_LIMIT},filter:{datetime_geq:$f,datetime_lt:$t,applicationId_in:$apps},orderBy:[datetimeFiveMinutes_ASC]){
    dimensions{datetimeFiveMinutes applicationId instanceId} sum{allocatedMemory}}}}}`;

export async function fetchUsage(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly UsageBucket[]> {
  const namespaces = await send(
    token,
    `${API}/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`,
  );

  const namespace = digArray(namespaces, "result")?.find(
    (entry) =>
      digString(entry, "script") === worker &&
      digString(entry, "class") === durableObjectClasses.WORKSPACE_HOST,
  );

  const namespaceId = digString(namespace, "id");
  const applications = await send(token, `${API}/accounts/${account}/containers/applications`);

  const application = digArray(applications, "result")?.find(
    (app) =>
      namespaceId !== null && digString(app, "durable_objects", "namespace_id") === namespaceId,
  );

  const id = digString(application, "id");

  if (id === null) {
    throw new ApiFailure(
      `no container application serves ${worker}'s ${durableObjectClasses.WORKSPACE_HOST} namespace`,
    );
  }

  const response = await send(token, `${API}/graphql`, {
    query: USAGE_QUERY,
    variables: {
      a: account,
      f: new Date(Math.floor(window.fromMs / BUCKET_MS) * BUCKET_MS).toISOString(),
      t: new Date(window.toMs).toISOString(),
      apps: [id],
    },
  });

  return parseUsage(response, WORKSPACE_CONTAINER_MEMORY_MIB * 1024 * 1024);
}
