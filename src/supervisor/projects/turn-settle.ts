import { earnsCompletedRealTurnCredit } from "../eligibility.js";
import type { RelayAttempt, RelayOutcome, TurnTerminal } from "../relay/index.js";
import type { ProjectThreadResult } from "../threads/index.js";
import type { TurnCreditInput } from "./turn-credit.js";
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

/** The relay record of this turn, read back at the commit and settled once at the end. */
export type TurnAttemptRecord = Readonly<{
  byId(attemptId: number): RelayAttempt | undefined;
  settle(
    attemptId: number,
    outcome: Exclude<RelayOutcome, "pending">,
    observedAt: number,
    turnTerminal?: TurnTerminal,
  ): void;
}>;

export type TurnCreditLedger = Readonly<{ record(input: TurnCreditInput): void }>;

/** How a turn's stream ended, before the Supervisor decides what to write down. */
export type StreamEnding =
  | Readonly<{ kind: "terminal"; frame: FacetTerminalFrame }>
  | Readonly<{ kind: "invalid"; problem: TurnStreamProblem }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timed-out" }>;

/**
 * What the turn is written down as: one frame for the browser, and the relay row's two facts.
 *
 * `outcome` is the transport fact. `turnTerminal` is what the turn itself said, and it is present
 * only when the Supervisor proved a terminal frame: a cancelled, timed-out, or protocol-breaking
 * stream never said how its turn ended, so it records nothing about one.
 */
export type TurnEnd = Readonly<{
  frame: ProjectTurnFrame;
  outcome: Exclude<RelayOutcome, "pending">;
  turnTerminal: TurnTerminal | undefined;
}>;

/** Everything the settlement needs. `projectTurnStream` holds it for the length of one turn. */
export type TurnSettlement = Readonly<{
  projectId: string;
  leaseId: string;
  attempt: RelayAttempt;
  threads: TurnThreadWrites;
  attempts: TurnAttemptRecord;
  credits: TurnCreditLedger;
  now: () => number;
}>;

/**
 * A turn that ended without producing a conversation the Supervisor may keep. The lease goes back
 * immediately rather than at its deadline, so the project is free for the next turn.
 */
function released(
  turn: TurnSettlement,
  frame: ProjectTurnFrame,
  outcome: TurnEnd["outcome"],
  turnTerminal?: TurnTerminal,
): TurnEnd {
  turn.threads.abandonTurn(turn.projectId, turn.leaseId);
  return { frame, outcome, turnTerminal };
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
  const now = turn.now();
  const saved = turn.threads.finishTurn(turn.projectId, turn.leaseId, messages, now);
  if (!saved.ok) {
    // Terminal success the Supervisor could not make durable is not success (ADR-0037).
    turn.threads.abandonTurn(turn.projectId, turn.leaseId);
    return { kind: "save-failed", code: saved.problem.code };
  }

  const attempt = turn.attempts.byId(turn.attempt.id) ?? turn.attempt;
  const credited = earnsCompletedRealTurnCredit({
    attempt,
    piTerminalSuccess: true,
    threadSaveCommitted: true,
  });
  if (credited) {
    turn.credits.record({
      attempt,
      projectId: turn.projectId,
      leaseId: turn.leaseId,
      threadRevision: saved.thread.revision,
      creditedAt: now,
    });
  }

  return {
    kind: "saved",
    revision: saved.thread.revision,
    messageCount: saved.thread.messageCount,
    credited,
  };
}

/**
 * A turn Pi ended with a failure. Its conversation is still saved, under the documented policy
 * that a model-call limit or a model error leaves real conversation the next turn continues from.
 * It never earns credit: goal criterion 6 gives credit to terminal success alone.
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

/**
 * The three endings a generation can state, each recorded as the clean body it was and as the
 * turn it actually was.
 *
 * The terminal kind travels to the relay row unchanged, including for a `completed` turn whose
 * save then failed: Pi did complete the turn, and the storage failure that followed is the
 * Supervisor's and is answered by withholding the credit in {@link saveCompletedTurn} instead.
 */
function settleTerminal(turn: TurnSettlement, frame: FacetTerminalFrame): TurnEnd {
  switch (frame.kind) {
    case "rejected":
      return released(
        turn,
        { kind: "turn-rejected", code: frame.code },
        "body-completed",
        "rejected",
      );
    case "failed":
      return {
        frame: saveFailedTurn(turn, frame.code, frame.messages),
        outcome: "body-completed",
        turnTerminal: "failed",
      };
    case "completed":
      return {
        frame: saveCompletedTurn(turn, frame.messages),
        outcome: "body-completed",
        turnTerminal: "completed",
      };
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard.
      const _exhaustive: never = frame;
      throw new Error(`unexpected terminal frame: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * The turn's ending as one frame for the browser and the facts the relay record keeps.
 *
 * These are different judgements about different things. A generation that streamed a clean turn
 * served a good response even when the Supervisor could not save the thread, so a save failure
 * settles `body-completed` and withholds the credit instead. A generation that broke the frame
 * protocol settles `body-failed`: a stream that never wrote a terminal frame did not complete a
 * turn, which is the completion evidence ADR-0031 recorded as missing.
 *
 * A rejection and a model failure sit between the two. Both served the browser a clean body, so
 * neither is a failed one, and neither completed a turn, so neither is credit either: the turn
 * terminal on the record is what keeps them out of both counts.
 */
export function endTurn(turn: TurnSettlement, ending: StreamEnding): TurnEnd {
  switch (ending.kind) {
    case "terminal":
      return settleTerminal(turn, ending.frame);
    case "invalid":
      return released(turn, { kind: "stream-invalid", code: ending.problem }, "body-failed");
    case "cancelled":
      // The lease goes back at once rather than at its deadline, and only this turn's own lease:
      // a turn that already lost the slot presents an id the store no longer holds, so the
      // release is refused and the replacement turn is untouched.
      return released(turn, { kind: "cancelled" }, "relay-cancelled");
    case "timed-out":
      return released(turn, { kind: "timed-out" }, "bounded-abandonment");
    default: {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Exhaustiveness guard.
      const _exhaustive: never = ending;
      throw new Error(`unexpected turn ending: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
