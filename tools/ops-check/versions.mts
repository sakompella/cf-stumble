import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { durableObjectClasses } from "../../infra/worker-settings.ts";
import type { JsonValue } from "../json.mts";
import { isoMinute, MINUTE_MS, type Finding, type Source, type TimeWindow } from "./check.mts";
import { ApiFailure, readToken, resolveAccount, send } from "./fetch.mts";
import { eventRows, TELEMETRY_ROW_LIMIT } from "./telemetry.mts";

export const DO_UPDATE_GRACE_MS = 5 * MINUTE_MS;

const API = "https://api.cloudflare.com/client/v4";

const DurableObjectClassNames: readonly string[] = Object.values(durableObjectClasses);

export interface Deployment {
  readonly deployedAtMs: number;
  readonly versionIds: readonly string[];
}

export interface StaleCall {
  readonly durableObject: string;
  readonly atMs: number;
  readonly version: string;
}

export interface VersionInput {
  readonly worker: string;
  readonly nowMs: number;
  readonly state: Source<{
    readonly deployment: Deployment;
    readonly staleCalls: readonly StaleCall[];
  }>;
}

const DeploymentsResponse = Schema.Struct({
  result: Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        created_on: Schema.String,
        versions: Schema.Array(Schema.Struct({ version_id: Schema.String })),
      }),
    ),
  }),
});

const StaleRow = Schema.Struct({
  timestamp: Schema.Number,
  $workers: Schema.Struct({
    entrypoint: Schema.String,
    scriptVersion: Schema.Struct({ id: Schema.String }),
  }),
});

export function parseLatestDeployment(response: JsonValue): Deployment {
  const parsed = Schema.decodeUnknownOption(DeploymentsResponse)(response);

  const latest = Option.isSome(parsed)
    ? parsed.value.result.deployments
        .map((deployment) => ({
          deployedAtMs: Date.parse(deployment.created_on),
          versionIds: deployment.versions.map((version) => version.version_id),
        }))
        .filter((deployment) => !Number.isNaN(deployment.deployedAtMs))
        .toSorted((a, b) => b.deployedAtMs - a.deployedAtMs)[0]
    : undefined;

  if (latest === undefined || latest.versionIds.length === 0) {
    throw new ApiFailure("the deployments response had no deployment or an unexpected shape");
  }

  return latest;
}

export function parseStaleCalls(response: JsonValue): readonly StaleCall[] {
  return eventRows(response).flatMap((row) => {
    const parsed = Schema.decodeUnknownOption(StaleRow)(row);

    return Option.isSome(parsed)
      ? [
          {
            durableObject: parsed.value.$workers.entrypoint,
            atMs: parsed.value.timestamp,
            version: parsed.value.$workers.scriptVersion.id,
          },
        ]
      : [];
  });
}

export async function fetchLatestDeployment(
  token: string,
  account: string,
  worker: string,
): Promise<Deployment> {
  return parseLatestDeployment(
    await send(token, `${API}/accounts/${account}/workers/scripts/${worker}/deployments`),
  );
}

export async function fetchStaleCalls(
  token: string,
  account: string,
  worker: string,
  window: TimeWindow,
  deployedVersions: readonly string[],
): Promise<readonly StaleCall[]> {
  const perClass = await Promise.all(
    DurableObjectClassNames.map(async (className) =>
      parseStaleCalls(
        await send(token, `${API}/accounts/${account}/workers/observability/telemetry/query`, {
          queryId: "adhoc",
          view: "events",
          dry: true,
          limit: TELEMETRY_ROW_LIMIT,
          timeframe: { from: window.fromMs, to: window.toMs },
          parameters: {
            filters: [
              { key: "$metadata.service", operation: "eq", type: "string", value: worker },
              { key: "$workers.entrypoint", operation: "eq", type: "string", value: className },
              ...deployedVersions.map((id) => ({
                key: "$workers.scriptVersion.id",
                operation: "neq",
                type: "string",
                value: id,
              })),
            ],
          },
        }),
      ),
    ),
  );

  return perClass.flat();
}

export async function gatherVersions(
  worker: string,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): Promise<VersionInput> {
  try {
    const token = readToken(env);
    const account = await resolveAccount(token, env);
    const deployment = await fetchLatestDeployment(token, account, worker);
    const fromMs = deployment.deployedAtMs + DO_UPDATE_GRACE_MS;

    const staleCalls =
      nowMs <= fromMs
        ? []
        : await fetchStaleCalls(
            token,
            account,
            worker,
            { fromMs, toMs: nowMs },
            deployment.versionIds,
          );

    return { worker, nowMs, state: { status: "ok", data: { deployment, staleCalls } } };
  } catch (cause) {
    const reason =
      cause instanceof ApiFailure ? cause.message : `unexpected failure: ${String(cause)}`;

    return { worker, nowMs, state: { status: "unavailable", reason } };
  }
}

export function versionFindings(input: VersionInput): readonly Finding[] {
  if (input.state.status !== "ok") {
    return [{ rule: "unknown", detail: input.state.reason, evidence: [] }];
  }

  const { deployment, staleCalls } = input.state.data;

  return DurableObjectClassNames.flatMap((className): Finding[] => {
    const calls = staleCalls
      .filter((call) => call.durableObject === className)
      .toSorted((a, b) => a.atMs - b.atMs);

    const [first] = calls;
    const last = calls.at(-1);

    if (first === undefined || last === undefined) return [];

    const versions = [...new Set(calls.map((call) => call.version.slice(0, 8)))];

    return [
      {
        rule: "do-version-skew",
        detail: `${className} ran ${versions.join(", ")} in ${calls.length} call(s) from ${isoMinute(first.atMs)} to ${isoMinute(last.atMs).slice(11)}, more than ${DO_UPDATE_GRACE_MS / MINUTE_MS} min after the ${isoMinute(deployment.deployedAtMs)} deployment of ${deployment.versionIds.map((id) => id.slice(0, 8)).join(", ")}`,
        evidence: [],
      },
    ];
  });
}
