/** The terminal outcomes of one model-route call, kept separate from provider text and errors. */
export type ModelCallOutcome = "completed" | "failed" | "aborted";

/**
 * Numeric accounting a facet can carry in its terminal frame. It contains no prompt, output, or
 * provider detail, so the host can log it without crossing the operational-log redaction boundary.
 */
export type ModelTurnAccounting = Readonly<{
  calls: number;
  totalMs: number;
  completed: number;
  failed: number;
  aborted: number;
}>;

type FinishedCall = Readonly<{ durationMs: number; outcome: ModelCallOutcome }>;

type Clock = () => number;

export interface ModelCallAccounting {
  start(): (outcome: ModelCallOutcome) => void;
  summary(): ModelTurnAccounting;
}

/**
 * Records each route call and returns a numeric per-turn summary. The clock is injectable so a
 * caller can test durations without waiting; a repeated settlement is ignored because stream
 * cancellation and a terminal event can race at the route boundary.
 */
export function createModelCallAccounting(now: Clock = Date.now): ModelCallAccounting {
  const calls: FinishedCall[] = [];

  return {
    start() {
      const startedAt = now();
      let settled = false;

      return (outcome) => {
        if (settled) return;
        settled = true;
        calls.push({ durationMs: Math.max(0, now() - startedAt), outcome });
      };
    },
    summary() {
      let totalMs = 0;
      let completed = 0;
      let failed = 0;
      let aborted = 0;

      for (const call of calls) {
        totalMs += call.durationMs;

        if (call.outcome === "completed") completed += 1;
        else if (call.outcome === "failed") failed += 1;
        else aborted += 1;
      }

      return { calls: calls.length, totalMs, completed, failed, aborted };
    },
  };
}
