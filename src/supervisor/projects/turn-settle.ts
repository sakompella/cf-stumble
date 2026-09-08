import type { ProjectThreadResult } from "../threads/index.js";
import type { FacetTerminalFrame, ProjectTurnFrame, TurnStreamProblem } from "./turn-frames.js";

/** The two thread writes a running turn can still make. Admission already happened. */
export type TurnThreadWrites = Readonly<{
  finishTurn(
    projectId: string,
    leaseId: string,
    messages: readonly unknown[],
    now: number,
  ): ProjectThreadResult;
  abandonTurn(projectId: string, leaseId: string): ProjectThreadResult;
}>;

/** How a turn's stream ended, before the Supervisor decides what to write down. */
export type StreamEnding =
  | Readonly<{ kind: "terminal"; frame: FacetTerminalFrame }>
  | Readonly<{ kind: "invalid"; problem: TurnStreamProblem }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timed-out" }>;

/** What the turn is written down as: one frame for the browser. */
export type TurnEnd = Readonly<{ frame: ProjectTurnFrame }>;

/** Everything the settlement needs. `projectTurnStream` holds it for the length of one turn. */
export type TurnSettlement = Readonly<{
  projectId: string;
  leaseId: string;
  threads: TurnThreadWrites;
  now: () => number;
}>;

/**
 * A turn that ended without producing a conversation the Supervisor may keep. The lease goes back
 * immediately rather than at its deadline, so the project is free for the next turn.
 */
function released(turn: TurnSettlement, frame: ProjectTurnFrame): TurnEnd {
  turn.threads.abandonTurn(turn.projectId, turn.leaseId);
  return { frame };
}

/**
 * Terminal success, made durable or not made at all.
 *
 * This is where the save-versus-cancel race is decided, and the durable commit is the line. The
 * block runs synchronously inside a single-threaded Durable Object, so a disconnect is observed
 * either before it, where the read that was waiting ends as a cancellation and nothing is written,
 * or after it, where the commit already returned and stands. There is no third outcome, and
 * nothing here can undo a save a previous statement committed.
 *
 * A disconnect before this point leaves no conversation to keep, and that is a fact about the
 * protocol rather than a choice: Pi state travels only in a terminal frame, so a turn cancelled
 * before its terminal frame has produced no messages the Supervisor could save (Q3). The text and
 * tool frames already sent are what the browser saw, not messages Pi handed over. Files the turn
 * changed stay changed, as on a normal development machine.
 */
function saveCompletedTurn(turn: TurnSettlement, messages: readonly unknown[]): ProjectTurnFrame {
  const saved = turn.threads.finishTurn(turn.projectId, turn.leaseId, messages, turn.now());
  if (!saved.ok) {
    // Terminal success the Supervisor could not make durable is not success (ADR-0037).
    turn.threads.abandonTurn(turn.projectId, turn.leaseId);
    return { kind: "save-failed", code: saved.problem.code };
  }

  return {
    kind: "saved",
    revision: saved.thread.revision,
    messageCount: saved.thread.messageCount,
  };
}

/**
 * A turn Pi ended with a failure. Its conversation is still saved, under the documented policy
 * that a model-call limit or a model error leaves real conversation the next turn continues from.
 */
function saveFailedTurn(
  turn: TurnSettlement,
  code: "model-call-limit" | "model-error",
  messages: readonly unknown[],
): ProjectTurnFrame {
  const saved = turn.threads.finishTurn(turn.projectId, turn.leaseId, messages, turn.now());
  if (!saved.ok) {
    turn.threads.abandonTurn(turn.projectId, turn.leaseId);
  }
  return {
    kind: "turn-failed",
    code,
    saved: saved.ok,
    revision: saved.ok ? saved.thread.revision : undefined,
  };
}

/** The three endings a generation can state, each written down as the turn it actually was. */
function settleTerminal(turn: TurnSettlement, frame: FacetTerminalFrame): TurnEnd {
  switch (frame.kind) {
    case "rejected":
      return released(turn, { kind: "turn-rejected", code: frame.code });
    case "failed":
      return { frame: saveFailedTurn(turn, frame.code, frame.messages) };
    case "completed":
      return { frame: saveCompletedTurn(turn, frame.messages) };
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard.
      const _exhaustive: never = frame;
      throw new Error(`unexpected terminal frame: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** The turn's ending as the one frame the browser reads. */
export function endTurn(turn: TurnSettlement, ending: StreamEnding): TurnEnd {
  switch (ending.kind) {
    case "terminal":
      return settleTerminal(turn, ending.frame);
    case "invalid":
      return released(turn, { kind: "stream-invalid", code: ending.problem });
    case "cancelled":
      // The lease goes back at once rather than at its deadline, and only this turn's own lease:
      // a turn that already lost the slot presents an id the store no longer holds, so the
      // release is refused and the replacement turn is untouched.
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
