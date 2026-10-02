import { runChecks } from "./check.mts";
import { at } from "./fixtures.mts";
import { MINUTE_MS, type CheckInput, type RuleId } from "./model.mts";

export const START = at("2026-10-01T00:00:00Z");

export const WINDOW = { fromMs: START, toMs: START + 6 * 60 * MINUTE_MS };

export function firing(checked: CheckInput): readonly RuleId[] {
  return [...new Set(runChecks(checked).map((finding) => finding.rule))].toSorted();
}
