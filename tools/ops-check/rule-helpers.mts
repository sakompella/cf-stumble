import { runChecks } from "./check.mts";
import { at, input, logs, metrics } from "./fixtures.mts";
import type { JsonRecord } from "../json.mts";
import { MINUTE_MS, type CheckInput, type RuleId } from "./model.mts";

export const START = at("2026-10-01T00:00:00Z");

export const WINDOW = { fromMs: START, toMs: START + 6 * 60 * MINUTE_MS };

export function firing(checked: CheckInput): readonly RuleId[] {
  return [...new Set(runChecks(checked).map((finding) => finding.rule))].toSorted();
}

/** A metrics source with rows but no CPU worth reporting, so only the rule under test can fire. */
export const CALM = metrics([[START, 1]], [[START, 0]]);

export function withLogs(
  events: readonly JsonRecord[],
  invocations: readonly JsonRecord[] = [],
): CheckInput {
  return input(WINDOW, { logs: logs(events, invocations), metrics: CALM });
}
