import { parseArgs } from "node:util";
import { PRODUCTION_STAGE, workerName } from "../../infra/worker-settings.ts";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.ts";
import {
  activityWindow,
  formatReport,
  MINUTE_MS,
  runChecks,
  type Activity,
  type CheckInput,
  type Finding,
  type TimeWindow,
} from "./check.mts";
import { fetchUsage, resolveAccount, settled, type Account } from "./fetch.mts";
import {
  fetchInvocations,
  fetchModelCalls,
  fetchRunSettlements,
  fetchRunStarts,
  fetchSessionFailures,
} from "./telemetry.mts";
import { gatherVersions, versionFindings } from "./versions.mts";

const USAGE = "usage: ops-check [--worker <name>] --since <90m|2h|1d>";

interface Options {
  readonly worker: string;
  readonly window: TimeWindow;
}

const UNIT_MS = new Map([
  ["m", MINUTE_MS],
  ["h", 60 * MINUTE_MS],
  ["d", 24 * 60 * MINUTE_MS],
]);

function parseOptions(argv: readonly string[], nowMs: number): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      worker: { type: "string" },
      since: { type: "string" },
    },
  });

  const since = /^(\d+)([mhd])$/u.exec(values.since ?? "");
  const unitMs = UNIT_MS.get(since?.[2] ?? "");

  if (since?.[1] === undefined || unitMs === undefined)
    throw new Error("--since must look like 90m, 2h or 1d");

  const fromMs = nowMs - Number(since[1]) * unitMs;

  return {
    worker: values.worker ?? workerName(PRODUCTION_STAGE),
    window: { fromMs, toMs: nowMs },
  };
}

async function readActivity(account: Account, { worker, window }: Options): Promise<Activity> {
  const requestWindow = activityWindow(window, WORKSPACE_IDLE_STOP_MS);

  const [invocations, usage, sessionFailures, runStarts, runSettlements] = await Promise.all([
    fetchInvocations(account, worker, requestWindow),
    fetchUsage(account, worker, window),
    fetchSessionFailures(account, worker, window),
    fetchRunStarts(account, worker, requestWindow),
    fetchRunSettlements(account, worker, requestWindow),
  ]);

  return { invocations, usage, sessionFailures, runStarts, runSettlements };
}

const nowMs = Date.now();

let options: Options;

try {
  options = parseOptions(process.argv.slice(2), nowMs);
} catch (cause) {
  console.error(`${cause instanceof Error ? cause.message : String(cause)}\n${USAGE}`);
  process.exit(2);
}

const account = await settled(resolveAccount(process.env));

const input: CheckInput = {
  worker: options.worker,
  nowMs,
  window: options.window,
  idleLimitMs: WORKSPACE_IDLE_STOP_MS,
  activity: account.status === "ok" ? await settled(readActivity(account.data, options)) : account,
};

const findings: readonly Finding[] = [
  ...runChecks(input),
  ...(account.status === "ok"
    ? versionFindings(await gatherVersions(account.data, options.worker, nowMs))
    : []),
];

const modelCalls =
  account.status === "ok" && input.activity.status === "ok"
    ? await fetchModelCalls(account.data, options.worker, options.window).catch(() => null)
    : null;

console.log(formatReport(input, findings, modelCalls).join("\n"));

process.exitCode = findings.length === 0 ? 0 : 1;
