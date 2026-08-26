import { assertNever } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { EffectsDifference } from "../replay/comparison.js";
import type { ReplayInconclusiveReason, ReplayOutcome, ReplaySession } from "../replay/index.js";
import type { RecordedCaseOutcome, ValidationExecutor } from "./results.js";

const EXECUTOR_TIMEOUT = Symbol("executor-timeout");

type ExecutorTimeout = typeof EXECUTOR_TIMEOUT;

export async function executeSafely(
  execute: ValidationExecutor,
  generation: Sha | undefined,
  session: ReplaySession,
  timeoutMs: number,
): Promise<ReplayOutcome> {
  try {
    const outcome = await withTimeout(execute(generation, session), timeoutMs);
    if (outcome === EXECUTOR_TIMEOUT) {
      return inconclusiveOutcome("timeout", `validation executor exceeded ${timeoutMs}ms`);
    }
    return outcome;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error : String(error);
    return inconclusiveOutcome("agent-error", `validation executor failed: ${errorDetail(detail)}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | ExecutorTimeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExecutorTimeout>((resolve) => {
    timer = setTimeout(() => {
      resolve(EXECUTOR_TIMEOUT);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function inconclusiveOutcome(reason: ReplayInconclusiveReason, detail: string): ReplayOutcome {
  return {
    status: "INCONCLUSIVE",
    reason,
    detail,
    effects: { trace: [], finalWorkspace: [] },
  };
}

function errorDetail(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

export function recordOutcome(outcome: ReplayOutcome): RecordedCaseOutcome {
  switch (outcome.status) {
    case "PASS":
      return { status: "PASS" };
    case "FAIL": {
      const difference: EffectsDifference = outcome.difference;
      return { status: "FAIL", difference };
    }
    case "INCONCLUSIVE": {
      const inconclusive: {
        readonly status: "INCONCLUSIVE";
        readonly reason: ReplayInconclusiveReason;
        readonly detail: string;
      } = {
        status: "INCONCLUSIVE",
        reason: outcome.reason,
        detail: outcome.detail,
      };
      return inconclusive;
    }
    default:
      return assertNever(outcome, "replay outcome");
  }
}
