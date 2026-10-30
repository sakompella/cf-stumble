import type { ProjectThreadResult } from "../threads/index.js";
import { logRedactedCause } from "../../diagnostics.js";
import type { FacetTerminalFrame, ProjectTurnFrame, TurnStreamProblem } from "./turn-frames.js";

export type TurnThreadWrites = Readonly<{
  finishTurn(
    projectId: string,
    leaseId: string,
    messages: readonly unknown[],
    now: number,
  ): ProjectThreadResult;
  abandonTurn(projectId: string, leaseId: string): ProjectThreadResult;
}>;

export type StreamEnding =
  | Readonly<{ kind: "terminal"; frame: FacetTerminalFrame }>
  | Readonly<{ kind: "invalid"; problem: TurnStreamProblem }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timed-out" }>;

export type TurnSettlement = Readonly<{
  projectId: string;
  leaseId: string;
  threads: TurnThreadWrites;
  now: () => number;
}>;

/**
 * Storage can close while a turn is ending. The lease deadline still fences a later admission, so a
 * failed release is logged under `context` and never replaces the error or terminal frame the
 * caller has.
 */
export function releaseLease(
  turn: Pick<TurnSettlement, "projectId" | "leaseId" | "threads">,
  context: string,
): void {
  try {
    turn.threads.abandonTurn(turn.projectId, turn.leaseId);
  } catch (cause) {
    logRedactedCause(`${context}: lease-release-failed`, cause);
  }
}

function released(turn: TurnSettlement, frame: ProjectTurnFrame): ProjectTurnFrame {
  releaseLease(turn, "turn-settle");

  return frame;
}

/**
 * The durable commit decides the save-versus-cancel race. The block runs synchronously in a single-
 * threaded Durable Object, so a disconnect is observed either before the commit (nothing is
 * written) or after it (the save stands). A turn cancelled before its terminal frame has no
 * messages to save, because Pi state travels only in that frame.
 */
function saveCompletedTurn(turn: TurnSettlement, messages: readonly unknown[]): ProjectTurnFrame {
  const saved = turn.threads.finishTurn(turn.projectId, turn.leaseId, messages, turn.now());

  if (!saved.ok) {
    releaseLease(turn, "turn-settle");

    return { kind: "save-failed", code: saved.problem.code };
  }

  return {
    kind: "saved",
    revision: saved.thread.revision,
    messageCount: saved.thread.messageCount,
  };
}

/**
 * Its conversation is still saved, so the next turn continues from it after a model-call limit or
 * model error.
 */
function saveFailedTurn(
  turn: TurnSettlement,
  code: "model-call-limit" | "model-error",
  messages: readonly unknown[],
): ProjectTurnFrame {
  const saved = turn.threads.finishTurn(turn.projectId, turn.leaseId, messages, turn.now());

  if (!saved.ok) {
    releaseLease(turn, "turn-settle");
  }

  return {
    kind: "turn-failed",
    code,
    saved: saved.ok,
    revision: saved.ok ? saved.thread.revision : undefined,
  };
}

function settleTerminal(turn: TurnSettlement, frame: FacetTerminalFrame): ProjectTurnFrame {
  switch (frame.kind) {
    case "rejected":
      return released(turn, { kind: "turn-rejected", code: frame.code });
    case "failed":
      return saveFailedTurn(turn, frame.code, frame.messages);
    case "completed":
      return saveCompletedTurn(turn, frame.messages);
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard.
      const _exhaustive: never = frame;
      throw new Error(`unexpected terminal frame: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function endTurn(turn: TurnSettlement, ending: StreamEnding): ProjectTurnFrame {
  switch (ending.kind) {
    case "terminal":
      return settleTerminal(turn, ending.frame);
    case "invalid":
      return released(turn, { kind: "stream-invalid", code: ending.problem });
    case "cancelled":
      // Release only this turn's own lease: a turn that lost the slot presents an id the store no
      // longer holds, so the replacement turn is untouched.
      return released(turn, { kind: "cancelled" });
    case "timed-out":
      return released(turn, { kind: "timed-out" });
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard.
      const _exhaustive: never = ending;
      throw new Error(`unexpected turn ending: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
