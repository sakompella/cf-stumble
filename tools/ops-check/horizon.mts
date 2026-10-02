import { METRICS_LAG_MS } from "./thresholds.mts";
import type { CheckInput } from "./model.mts";

/**
 * How far the metrics can be trusted, and whether the window reaches the present.
 *
 * The newest metrics buckets are incomplete, so rules read only buckets that end by
 * `completeUntilMs`. Only a window that ends at the present can ask the Containers API what runs
 * now; for an older window that answer says nothing about the window.
 */
export interface Horizon {
  readonly completeUntilMs: number;
  readonly live: boolean;
}

export function horizonOf(input: CheckInput): Horizon {
  const latestCompleteMs = input.nowMs - METRICS_LAG_MS;

  return {
    completeUntilMs: Math.min(input.window.toMs, latestCompleteMs),
    live: input.window.toMs >= latestCompleteMs,
  };
}
