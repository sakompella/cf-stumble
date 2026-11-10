import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  durableObjectClasses,
  WORKSPACE_CONTAINER_MEMORY_MIB,
} from "../../infra/worker-settings.ts";
import type { JsonRecord, JsonValue } from "../json.mts";
import { BUCKET_MS, type TimeWindow, type UsageBucket } from "./check.mts";

const API = "https://api.cloudflare.com/client/v4";

const METRICS_ROW_LIMIT = 5000;

export class ApiFailure extends Error {}

function decoded<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  message: string,
): S["Type"] {
  const parsed = Schema.decodeUnknownOption(schema)(value);

  if (Option.isNone(parsed)) throw new ApiFailure(message);

  return parsed.value;
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const AccountsResponse = Schema.Struct({
  result: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const UsageEnvelope = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Json))),
  data: Schema.Struct({
    viewer: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({ containersUsageAdaptiveGroups: Schema.Array(Schema.Json) }),
      ),
    }),
  }),
});

const UsageRow = Schema.Struct({
  dimensions: Schema.Struct({ datetimeFiveMinutes: Schema.String }),
  sum: Schema.Struct({ allocatedMemory: Schema.Number }),
});

const NamespacesResponse = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ script: Schema.String, class: Schema.String, id: Schema.String }),
  ),
});

const ApplicationsResponse = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      durable_objects: Schema.optional(Schema.Struct({ namespace_id: Schema.String })),
    }),
  ),
});

const LoginFile = Schema.Struct({ oauth_token: Schema.String });

const CF_LOGIN_FILE = join(homedir(), ".config", "cloudflare", "config", "default.json");

const NO_LOGIN = `no CLOUDFLARE_API_TOKEN and no cf login in ${CF_LOGIN_FILE}`;

export function readToken(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["CLOUDFLARE_API_TOKEN"]?.trim() ?? "";

  if (fromEnv !== "") return fromEnv;

  let token: string | undefined;

  try {
    token = Option.getOrUndefined(
      Option.map(
        Schema.decodeUnknownOption(Schema.fromJsonString(LoginFile))(
          readFileSync(CF_LOGIN_FILE, "utf8"),
        ),
        (login) => login.oauth_token,
      ),
    );
  } catch {
    token = undefined;
  }

  if (token === undefined || token === "") {
    throw new ApiFailure(NO_LOGIN);
  }

  return token;
}

export async function send(token: string, url: string, body?: JsonRecord): Promise<JsonValue> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

  if (!response.ok) {
    throw new ApiFailure(`HTTP ${response.status} from ${new URL(url).pathname}`);
  }

  return Option.getOrElse(decodeJsonText(await response.text().catch(() => "")), () => null);
}

export async function resolveAccount(token: string, env: NodeJS.ProcessEnv): Promise<string> {
  const named = env["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";

  if (named !== "") return named;

  const accounts = decoded(
    AccountsResponse,
    await send(token, `${API}/accounts`),
    "the accounts response had an unexpected shape",
  );

  const ids = accounts.result.map((account) => account.id);

  if (ids.length !== 1 || ids[0] === undefined) {
    throw new ApiFailure(`token sees ${ids.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
  }

  return ids[0];
}

export function parseUsage(response: JsonValue, memoryBytes: number): readonly UsageBucket[] {
  const envelope = decoded(
    UsageEnvelope,
    response,
    "GraphQL response had errors or an unexpected shape",
  );

  if (envelope.errors !== null && envelope.errors !== undefined && envelope.errors.length > 0) {
    throw new ApiFailure("GraphQL response had errors or an unexpected shape");
  }

  const account = envelope.data.viewer.accounts[0];

  if (account === undefined) {
    throw new ApiFailure("GraphQL response had errors or an unexpected shape");
  }

  const rows = account.containersUsageAdaptiveGroups;

  if (rows.length >= METRICS_ROW_LIMIT) {
    throw new ApiFailure("GraphQL usage reached its row limit; use a shorter --since");
  }

  const byteSeconds = new Map<number, number>();

  for (const row of rows) {
    const parsed = Schema.decodeUnknownResult(UsageRow)(row);

    if (Result.isFailure(parsed)) throw new ApiFailure("GraphQL usage row had an unexpected shape");

    const startMs = Date.parse(parsed.success.dimensions.datetimeFiveMinutes);

    if (Number.isNaN(startMs)) throw new ApiFailure("GraphQL usage row had an unexpected shape");

    byteSeconds.set(startMs, (byteSeconds.get(startMs) ?? 0) + parsed.success.sum.allocatedMemory);
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
  const namespaces = decoded(
    NamespacesResponse,
    await send(
      token,
      `${API}/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`,
    ),
    `no container application serves ${worker}'s ${durableObjectClasses.WORKSPACE_HOST} namespace`,
  );

  const namespace = namespaces.result.find(
    (entry) => entry.script === worker && entry.class === durableObjectClasses.WORKSPACE_HOST,
  );

  const applications = decoded(
    ApplicationsResponse,
    await send(token, `${API}/accounts/${account}/containers/applications`),
    `no container application serves ${worker}'s ${durableObjectClasses.WORKSPACE_HOST} namespace`,
  );

  const application = applications.result.find(
    (app) => namespace !== undefined && app.durable_objects?.namespace_id === namespace.id,
  );

  if (application === undefined) {
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
      apps: [application.id],
    },
  });

  return parseUsage(response, WORKSPACE_CONTAINER_MEMORY_MIB * 1024 * 1024);
}
