import { parseArgs } from "node:util";
import { HOUR_MS, MINUTE_MS, type TimeWindow } from "./model.mts";
import { DEFAULT_IDLE_LIMIT_MS } from "./thresholds.mts";

export interface Options {
  readonly worker: string;
  readonly window: TimeWindow;
  readonly idleLimitMs: number;
  readonly json: boolean;
  readonly account: string | null;
  readonly tokenFile: string | null;
}

function unitMs(unit: string): number | null {
  switch (unit) {
    case "m":
      return MINUTE_MS;
    case "h":
      return HOUR_MS;
    case "d":
      return 24 * HOUR_MS;
    default:
      return null;
  }
}

/** `90m`, `2h` or `1d` as milliseconds; `null` for anything else. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)([mhd])$/u.exec(text);
  const unit = match?.[2] === undefined ? null : unitMs(match[2]);

  return match?.[1] === undefined || unit === null ? null : Number(match[1]) * unit;
}

function parseInstant(text: string): number | null {
  const ms = Date.parse(text);

  return Number.isNaN(ms) ? null : ms;
}

export const USAGE =
  "usage: ops-check --worker <name> (--since <90m|2h|1d> | --from <ISO> [--to <ISO>]) " +
  "[--idle-minutes 20] [--account <id>] [--token-file <path>] [--json]";

/** Parse the command line, or answer the reason it is wrong. `nowMs` makes the window testable. */
export type ParsedOptions =
  | { readonly kind: "options"; readonly options: Options }
  | { readonly kind: "invalid"; readonly reason: string };

function invalid(reason: string): ParsedOptions {
  return { kind: "invalid", reason };
}

export function parseOptions(argv: readonly string[], nowMs: number): ParsedOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      worker: { type: "string" },
      since: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "idle-minutes": { type: "string", default: String(DEFAULT_IDLE_LIMIT_MS / MINUTE_MS) },
      account: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  const sinceMs = values.since === undefined ? null : parseDuration(values.since);
  const toMs = values.to === undefined ? nowMs : parseInstant(values.to);
  const fromMs = values.from === undefined ? null : parseInstant(values.from);
  const idleMinutes = Number(values["idle-minutes"]);

  if (values.worker === undefined) return invalid("--worker is required");

  if (toMs === null) return invalid("--to is not a date");

  if (values.since !== undefined && sinceMs === null)
    return invalid("--since must look like 90m, 2h or 1d");

  if (values.from !== undefined && fromMs === null) return invalid("--from is not a date");

  if (fromMs === null && sinceMs === null) return invalid("give --since or --from");

  if (!(idleMinutes > 0)) return invalid("--idle-minutes must be a positive number");

  const start = fromMs ?? toMs - (sinceMs ?? 0);

  if (start >= toMs) return invalid("the window is empty");

  return {
    kind: "options",
    options: {
      worker: values.worker,
      window: { fromMs: start, toMs },
      idleLimitMs: idleMinutes * MINUTE_MS,
      json: values.json,
      account: values.account ?? null,
      tokenFile: values["token-file"] ?? null,
    },
  };
}
