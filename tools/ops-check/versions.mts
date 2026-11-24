import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { durableObjectClasses } from "../../infra/worker-settings.ts";
import { isoMinute, MINUTE_MS, type Finding, type Source, type TimeWindow } from "./check.mts";
import { ApiFailure, sendToAccount, settled, type Account } from "./fetch.mts";
import { eventRows, queryTelemetry } from "./telemetry.mts";

const DO_UPDATE_GRACE_MS = 5 * MINUTE_MS;

const DurableObjectClassNames: readonly string[] = Object.values(durableObjectClasses);

interface Deployment {
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

export function parseLatestDeployment(response: Schema.Json): Deployment {
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

export function parseStaleCalls(response: Schema.Json): readonly StaleCall[] {
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

async function fetchLatestDeployment(account: Account, worker: string): Promise<Deployment> {
  return parseLatestDeployment(
    await sendToAccount(account, `/workers/scripts/${worker}/deployments`),
  );
}

async function fetchStaleCalls(
  account: Account,
  worker: string,
  window: TimeWindow,
  deployedVersions: readonly string[],
): Promise<readonly StaleCall[]> {
  const perClass = await Promise.all(
    DurableObjectClassNames.map(async (className) =>
      parseStaleCalls(
        await queryTelemetry(account, worker, window, [
          { key: "$workers.entrypoint", operation: "eq", value: className },
          ...deployedVersions.map((id) => ({
            key: "$workers.scriptVersion.id",
            operation: "neq" as const,
            value: id,
          })),
        ]),
      ),
    ),
  );

  return perClass.flat();
}

export async function gatherVersions(
  account: Account,
  worker: string,
  nowMs: number,
): Promise<VersionInput> {
  const state = await settled(
    fetchLatestDeployment(account, worker).then(async (deployment) => {
      const fromMs = deployment.deployedAtMs + DO_UPDATE_GRACE_MS;

      const staleCalls =
        nowMs <= fromMs
          ? []
          : await fetchStaleCalls(account, worker, { fromMs, toMs: nowMs }, deployment.versionIds);

      return { deployment, staleCalls };
    }),
  );

  return { worker, nowMs, state };
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
