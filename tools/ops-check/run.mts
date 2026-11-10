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
  type ModelCalls,
  type TimeWindow,
} from "./check.mts";
import { fetchUsage, readToken, resolveAccount, ApiFailure } from "./fetch.mts";
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

async function readActivity(options: Options): Promise<Activity> {
  const { worker, window } = options;
  const token = readToken(process.env);
  const account = await resolveAccount(token, process.env);

  const requestWindow = activityWindow(window, WORKSPACE_IDLE_STOP_MS);

  const [invocations, usage, sessionFailures, runStarts, runSettlements] = await Promise.all([
    fetchInvocations(token, account, worker, requestWindow),
    fetchUsage(token, account, worker, window),
    fetchSessionFailures(token, account, worker, window),
    fetchRunStarts(token, account, worker, requestWindow),
    fetchRunSettlements(token, account, worker, requestWindow),
  ]);

  return { invocations, usage, sessionFailures, runStarts, runSettlements };
}

async function readModelCalls(options: Options): Promise<ModelCalls | null> {
  try {
    const token = readToken(process.env);
    const account = await resolveAccount(token, process.env);

    return await fetchModelCalls(token, account, options.worker, options.window);
  } catch {
    return null;
  }
}

async function gather(options: Options, nowMs: number): Promise<CheckInput> {
  const { worker, window } = options;
  const idleLimitMs = WORKSPACE_IDLE_STOP_MS;

  try {
    return {
      worker,
      nowMs,
      window,
      idleLimitMs,
      activity: { status: "ok", data: await readActivity(options) },
    };
  } catch (cause) {
    const reason =
      cause instanceof ApiFailure ? cause.message : `unexpected failure: ${String(cause)}`;

    return { worker, nowMs, window, idleLimitMs, activity: { status: "unavailable", reason } };
  }
}

const nowMs = Date.now();

let options: Options;

try {
  options = parseOptions(process.argv.slice(2), nowMs);
} catch (cause) {
  console.error(`${cause instanceof Error ? cause.message : String(cause)}\n${USAGE}`);
  process.exit(2);
}

const input = await gather(options, nowMs);

const findings = [
  ...runChecks(input),
  ...versionFindings(await gatherVersions(options.worker, nowMs, process.env)),
];

const modelCalls = input.activity.status === "ok" ? await readModelCalls(options) : null;

console.log(formatReport(input, findings, modelCalls).join("\n"));

process.exitCode = findings.length === 0 ? 0 : 1;
