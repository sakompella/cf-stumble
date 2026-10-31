import { parseArgs } from "node:util";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.ts";
import {
  formatReport,
  MINUTE_MS,
  runChecks,
  type Activity,
  type CheckInput,
  type TimeWindow,
} from "./check.mts";
import { fetchInvocations, fetchUsage, readToken, resolveAccount, ApiFailure } from "./fetch.mts";

const USAGE =
  "usage: ops-check --worker <name> (--since <90m|2h|1d> | --from <ISO> [--to <ISO>]) " +
  "[--idle-minutes 10] [--account <id>] [--token-file <path>] [--json]";

interface Options {
  readonly worker: string;
  readonly window: TimeWindow;
  readonly idleLimitMs: number;
  readonly json: boolean;
  readonly account: string | null;
  readonly tokenFile: string | null;
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
      from: { type: "string" },
      to: { type: "string" },
      "idle-minutes": { type: "string", default: String(WORKSPACE_IDLE_STOP_MS / MINUTE_MS) },
      account: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  if (values.worker === undefined) throw new Error("--worker is required");

  const toMs = values.to === undefined ? nowMs : Date.parse(values.to);

  if (Number.isNaN(toMs)) throw new Error("--to is not a date");

  if (toMs > nowMs) throw new Error("--to is in the future");

  const since = /^(\d+)([mhd])$/u.exec(values.since ?? "");
  const unitMs = UNIT_MS.get(since?.[2] ?? "");

  const fromMs =
    values.from === undefined
      ? since?.[1] === undefined || unitMs === undefined
        ? Number.NaN
        : toMs - Number(since[1]) * unitMs
      : Date.parse(values.from);

  if (values.from === undefined && values.since === undefined)
    throw new Error("give --since or --from");

  if (Number.isNaN(fromMs))
    throw new Error("--since must look like 90m, 2h or 1d, and --from must be a date");

  if (fromMs >= toMs) throw new Error("the window is empty");

  const idleMinutes = Number(values["idle-minutes"]);

  if (!(idleMinutes > 0)) throw new Error("--idle-minutes must be a positive number");

  return {
    worker: values.worker,
    window: { fromMs, toMs },
    idleLimitMs: idleMinutes * MINUTE_MS,
    json: values.json,
    account: values.account ?? null,
    tokenFile: values["token-file"] ?? null,
  };
}

async function readActivity(options: Options): Promise<Activity> {
  const { worker, window, idleLimitMs } = options;
  const token = readToken(options.tokenFile, process.env);
  const account = await resolveAccount(token, options.account, process.env);

  const requestWindow = { ...window, fromMs: window.fromMs - idleLimitMs };

  const [invocations, usage] = await Promise.all([
    fetchInvocations(token, account, worker, requestWindow),
    fetchUsage(token, account, worker, window),
  ]);

  return { invocations, usage };
}

async function gather(options: Options, nowMs: number): Promise<CheckInput> {
  const { worker, window, idleLimitMs } = options;

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

const findings = runChecks(input);

console.log(
  options.json
    ? JSON.stringify({ worker: input.worker, ok: findings.length === 0, findings }, null, 2)
    : formatReport(input, findings).join("\n"),
);

process.exitCode = findings.length === 0 ? 0 : 1;
