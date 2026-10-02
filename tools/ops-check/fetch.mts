/**
 * The network edge of `ops:check`: three Cloudflare APIs, each answered as a typed source.
 * No rule logic lives here and no test covers it, because it needs a live account. Tokens go in
 * the Authorization header only; no message or error text includes one.
 */
import { readFileSync } from "node:fs";
import {
  isJsonArray,
  isJsonRecord,
  isJsonString,
  parseJsonRecordText,
  type JsonRecord,
  type JsonValue,
} from "../browser-harness/json.mts";
import {
  BUCKET_MS,
  type RunningInstance,
  type LogData,
  type MetricData,
  type Source,
  type TimeWindow,
} from "./model.mts";
import {
  parseApplications,
  parseInstances,
  parseMetrics,
  parseTelemetry,
  type ContainerApplication,
} from "./parse.mts";
import { TELEMETRY_ROW_LIMIT } from "./thresholds.mts";

const API = "https://api.cloudflare.com/client/v4";

/** The token from CLOUDFLARE_API_TOKEN, or from a file holding the bare token or `cf` login JSON. */
export function readToken(tokenFile: string | null, env: NodeJS.ProcessEnv): string | null {
  const content =
    tokenFile === null ? (env["CLOUDFLARE_API_TOKEN"] ?? "") : readFileSync(tokenFile, "utf8");

  const trimmed = content.trim();
  const login = parseJsonRecordText(trimmed);
  const oauth = login?.["oauth_token"];

  if (login === undefined) {
    return trimmed === "" ? null : trimmed;
  }

  return oauth !== undefined && isJsonString(oauth) ? oauth : null;
}

class ApiFailure extends Error {}

function post(token: string, url: string, body: JsonRecord): Promise<JsonValue> {
  return send(token, url, { method: "POST", body: JSON.stringify(body) });
}

async function send(token: string, url: string, init: RequestInit): Promise<JsonValue> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a JSON response body is JSON; the parsers check its shape before reading it.
  const body = (await response.json().catch(() => null)) as JsonValue;

  if (!response.ok) {
    throw new ApiFailure(`HTTP ${response.status} from ${new URL(url).pathname}`);
  }

  return body;
}

function describe(cause: Error | string): string {
  return cause instanceof Error ? cause.message : cause;
}

async function guarded<T>(run: () => Promise<Source<T>>): Promise<Source<T>> {
  try {
    return await run();
  } catch (cause) {
    return {
      status: "unavailable",
      reason: describe(cause instanceof Error ? cause : String(cause)),
    };
  }
}

export async function resolveAccount(token: string, requested: string | null): Promise<string> {
  if (requested !== null) return requested;

  const response = await send(token, `${API}/accounts`, { method: "GET" });
  const accounts = isJsonRecord(response) ? response["result"] : undefined;

  const ids =
    accounts !== undefined && isJsonArray(accounts)
      ? accounts.flatMap((account) => {
          const id = isJsonRecord(account) ? account["id"] : undefined;

          return id !== undefined && isJsonString(id) ? [id] : [];
        })
      : [];

  if (ids.length !== 1 || ids[0] === undefined) {
    throw new ApiFailure(`token sees ${ids.length} accounts; pass --account`);
  }

  return ids[0];
}

function telemetryQuery(window: TimeWindow, filters: readonly JsonRecord[]): JsonRecord {
  return {
    queryId: "adhoc",
    view: "events",
    dry: true,
    limit: TELEMETRY_ROW_LIMIT,
    timeframe: { from: window.fromMs, to: window.toMs },
    parameters: { filters },
  };
}

/** Every event and canceled fetch invocation that `worker` wrote over `window`. */
export function fetchLogs(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<Source<LogData>> {
  const url = `${API}/accounts/${account}/workers/observability/telemetry/query`;
  const service = { key: "$metadata.service", operation: "eq", type: "string", value: worker };
  const events = [service, { key: "event", operation: "exists", type: "string" }];

  const canceled = [
    service,
    { key: "$workers.outcome", operation: "eq", type: "string", value: "canceled" },
    { key: "$workers.eventType", operation: "eq", type: "string", value: "fetch" },
  ];

  return guarded(async () =>
    parseTelemetry(
      await post(token, url, telemetryQuery(window, events)),
      await post(token, url, telemetryQuery(window, canceled)),
      worker,
    ),
  );
}

const METRICS = `query($a:String!,$f:Time!,$t:Time!,$apps:[string!]){viewer{accounts(filter:{accountTag:$a}){
  containersMetricsAdaptiveGroups(limit:5000,filter:{datetime_geq:$f,datetime_lt:$t,applicationId_in:$apps},orderBy:[datetimeFiveMinutes_ASC]){
    dimensions{datetimeFiveMinutes applicationId instanceId} sum{cpuTimeSec}}}}}`;

const USAGE = `query($a:String!,$f:Time!,$t:Time!,$apps:[string!]){viewer{accounts(filter:{accountTag:$a}){
  containersUsageAdaptiveGroups(limit:5000,filter:{datetime_geq:$f,datetime_lt:$t,applicationId_in:$apps},orderBy:[datetimeFiveMinutes_ASC]){
    dimensions{datetimeFiveMinutes applicationId instanceId} sum{allocatedMemory}}}}}`;

/** The Worker's Containers application is named after the Worker and its class, lowercased. */
export function fetchApplications(
  token: string,
  account: string,
  worker: string,
): Promise<Source<readonly ContainerApplication[]>> {
  const name = `${worker}-workspacehost`;

  return guarded(async () => {
    const all = parseApplications(
      await send(token, `${API}/accounts/${account}/containers/applications`, { method: "GET" }),
    );

    const found = all?.filter((application) => application.name === name) ?? [];

    return found.length === 0
      ? { status: "unavailable", reason: `no container application named ${name}` }
      : { status: "ok", data: found };
  });
}

/** Container CPU and allocated time for the Worker's container application. */
export function fetchMetrics(
  token: string,
  account: string,
  applications: readonly ContainerApplication[],
  window: TimeWindow,
): Promise<Source<MetricData>> {
  return guarded(async () => {
    const memory = applications[0]?.memoryBytes;

    if (memory === undefined) {
      return { status: "unavailable", reason: "no container application" };
    }

    const variables = {
      a: account,
      f: new Date(Math.floor(window.fromMs / BUCKET_MS) * BUCKET_MS).toISOString(),
      t: new Date(window.toMs).toISOString(),
      apps: applications.map((application) => application.id),
    };

    const run = (query: string) => post(token, `${API}/graphql`, { query, variables });

    return parseMetrics(await run(METRICS), await run(USAGE), memory);
  });
}

/** What the Containers API says is running now. Metrics lag; this does not. */
export function fetchInstances(
  token: string,
  account: string,
  applications: readonly ContainerApplication[],
): Promise<Source<readonly RunningInstance[]>> {
  return guarded(async () => {
    const answers = await Promise.all(
      applications.map(async (application) =>
        parseInstances(
          await send(
            token,
            `${API}/accounts/${account}/containers/applications/${application.id}/instances`,
            { method: "GET" },
          ),
        ),
      ),
    );

    return answers.includes(null)
      ? { status: "unavailable", reason: "instances response had an unexpected shape" }
      : { status: "ok", data: answers.flatMap((instances) => instances ?? []) };
  });
}
