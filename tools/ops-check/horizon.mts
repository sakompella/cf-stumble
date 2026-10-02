import { LIVE_SLACK_MS, METRICS_LAG_MS } from "./thresholds.mts";
import type { CheckInput } from "./model.mts";

/**
 * How far the metrics can be trusted, and whether the window reaches the present.
 *
 * The newest metrics buckets are incomplete, so rules read only buckets that end by
 * `completeUntilMs`. Only a window that ends at the present (within `LIVE_SLACK_MS` of the check)
 * can ask the Containers API what runs now; an explicit older `--to`, even a few minutes old, is a
 * history query, and the answer for now says nothing about it. The two questions are separate: a
 * window can be history and still end inside the metrics lag.
 */
export interface Horizon {
  readonly completeUntilMs: number;
  readonly live: boolean;
}

export function horizonOf(input: CheckInput): Horizon {
  const latestCompleteMs = input.nowMs - METRICS_LAG_MS;

  return {
    completeUntilMs: Math.min(input.window.toMs, latestCompleteMs),
    live: input.window.toMs >= input.nowMs - LIVE_SLACK_MS,
  };
}
