/**
 * The network edge of `ops:check`: Workers Logs, the Containers API and GraphQL, each read into
 * the types of `check.mts`. A failure or a cut-off answer throws `ApiFailure`, which the caller
 * reports as `unknown`. A token goes in the Authorization header only; no message includes one.
 */
import { readFileSync } from "node:fs";
import { routePattern } from "../../src/routes/route-pattern.ts";
import {
  isJsonArray,
  isJsonNumber,
  isJsonRecord,
  isJsonString,
  parseJsonRecordText,
  type JsonRecord,
  type JsonValue,
} from "../json.mts";
import { BUCKET_MS, type Invocation, type TimeWindow, type UsageBucket } from "./check.mts";

const API = "https://api.cloudflare.com/client/v4";

/** An answer this long may be cut off. */
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

/** The token from CLOUDFLARE_API_TOKEN, or from a file holding the bare token or `cf` login JSON. */
export function readToken(tokenFile: string | null, env: NodeJS.ProcessEnv): string {
  let content: string;

  try {
    content =
      tokenFile === null ? (env["CLOUDFLARE_API_TOKEN"] ?? "") : readFileSync(tokenFile, "utf8");
  } catch {
    throw new ApiFailure("cannot read --token-file");
  }

  const trimmed = content.trim();
  const login = parseJsonRecordText(trimmed);
  const token = login === undefined ? trimmed : digString(login, "oauth_token");

  if (token === null || token === "") {
    throw new ApiFailure("no CLOUDFLARE_API_TOKEN and no --token-file");
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a JSON response body is JSON; callers check its shape before reading it.
  return (await response.json().catch(() => null)) as JsonValue;
}

/** The account to query: `--account`, then CLOUDFLARE_ACCOUNT_ID, then the token's only account. */
export async function resolveAccount(
  token: string,
  requested: string | null,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const named = requested ?? env["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";

  if (named !== "") return named;

  const accounts = digArray(await send(token, `${API}/accounts`), "result") ?? [];
  const ids = accounts.flatMap((account) => digString(account, "id") ?? []);

  if (ids.length !== 1 || ids[0] === undefined) {
    throw new ApiFailure(`token sees ${ids.length} accounts; pass --account`);
  }

  return ids[0];
}

export function parseInvocations(response: JsonValue): readonly Invocation[] {
  const rows = digArray(response, "result", "events", "events");

  if (rows === null) throw new ApiFailure("telemetry response had an unexpected shape");

  if (rows.length >= TELEMETRY_ROW_LIMIT) {
    throw new ApiFailure(
      `telemetry returned ${TELEMETRY_ROW_LIMIT} requests, the most it gives; use a shorter --since`,
    );
  }

  // Log lines come back from the same query; only an invocation's own row has a wall time.
  return rows.flatMap((row) => {
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

/** Every fetch invocation `worker` ran over `window`. */
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

/** Running minutes per five-minute bucket: `allocatedMemory` byte-seconds over provisioned memory. */
export function parseUsage(response: JsonValue, memoryBytes: number): readonly UsageBucket[] {
  const account = digArray(response, "data", "viewer", "accounts")?.[0];
  const rows = digArray(account, "containersUsageAdaptiveGroups");

  if (dig(response, "errors") !== undefined || rows === null) {
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

/** Running time of the Worker's Containers application, which is named after the Worker and its class. */
export async function fetchUsage(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
): Promise<readonly UsageBucket[]> {
  const name = `${worker}-workspacehost`;
  const applications = await send(token, `${API}/accounts/${account}/containers/applications`);

  const application = digArray(applications, "result")?.find(
    (app) => digString(app, "name") === name,
  );

  const id = digString(application, "id");
  const memoryMib = digNumber(application, "configuration", "memory_mib");

  if (id === null || memoryMib === null) {
    throw new ApiFailure(`no container application named ${name}`);
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

  return parseUsage(response, memoryMib * 1024 * 1024);
}
