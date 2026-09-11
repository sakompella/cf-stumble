import type { ProjectId } from "../../project-catalog.js";
import type { ProjectThread, ThreadProblem } from "./thread.js";

/**
 * Pure deciders for the thread store. Each takes the current thread and returns a plain decision.
 * The imperative shell in store.ts reads the thread, calls a decider, and applies the effect the
 * decision names inside one Durable Object transaction, so the row cannot change between the read
 * and the write (ADR-0036).
 *
 * A turn holds the project's thread until its deadline. The facet that starts a turn can die
 * before it finishes, and nothing else would ever release the slot, so admission treats a turn
 * whose deadline has passed as free and lets the next caller take it over.
 *
 * Admission mints a lease id, and only that id may finish or abandon the turn it admitted. The
 * row holds one lease id at a time, and every commit, abandonment, and fresh thread clears it, so
 * a presented id that still matches proves both that this caller was admitted and that the thread
 * has not moved on to a replacement turn at the same revision.
 */

function holdsTurn(current: ProjectThread, now: number): boolean {
  return current.turnActive && (current.turnDeadlineAt ?? 0) > now;
}

/** The lease the row holds against the lease a caller presented to complete its turn. */
export type TurnLeaseClaim = Readonly<{
  held: string | undefined;
  presented: string;
}>;

function ownsTurn(claim: TurnLeaseClaim): boolean {
  return claim.held !== undefined && claim.held === claim.presented;
}

export type StartTurnDecision =
  | Readonly<{ kind: "rejected"; problem: ThreadProblem }>
  | Readonly<{ kind: "started"; revision: number }>;

export function decideStartTurn(
  projectId: ProjectId,
  current: ProjectThread,
  expectedRevision: number,
  now: number,
): StartTurnDecision {
  if (holdsTurn(current, now)) {
    return {
      kind: "rejected",
      problem: { code: "turn-conflict", projectId, deadlineAt: current.turnDeadlineAt ?? 0 },
    };
  }

  if (expectedRevision !== current.revision) {
    return {
      kind: "rejected",
      problem: { code: "stale-revision", projectId, currentRevision: current.revision },
    };
  }

  return { kind: "started", revision: current.revision };
}

export type FinishTurnDecision =
  | Readonly<{ kind: "rejected"; problem: ThreadProblem }>
  | Readonly<{ kind: "finished"; nextRevision: number }>;

export function decideFinishTurn(
  projectId: ProjectId,
  current: ProjectThread,
  claim: TurnLeaseClaim,
  now: number,
): FinishTurnDecision {
  if (!current.turnActive) {
    return { kind: "rejected", problem: { code: "turn-not-active", projectId } };
  }

  if (!ownsTurn(claim)) {
    return { kind: "rejected", problem: { code: "turn-lease-lost", projectId } };
  }

  if (!holdsTurn(current, now)) {
    return {
      kind: "rejected",
      problem: { code: "turn-expired", projectId, deadlineAt: current.turnDeadlineAt ?? 0 },
    };
  }

  return { kind: "finished", nextRevision: current.revision + 1 };
}

export type AbandonTurnDecision =
  | Readonly<{ kind: "rejected"; problem: ThreadProblem }>
  | Readonly<{ kind: "abandoned" }>;

/**
 * Abandoning is releasing the slot a caller was admitted to, so it asks for the lease but not for
 * a live deadline: a turn that ran past its deadline and nobody took over may still clean up.
 */
export function decideAbandonTurn(
  projectId: ProjectId,
  current: ProjectThread,
  claim: TurnLeaseClaim,
): AbandonTurnDecision {
  if (!current.turnActive) {
    return { kind: "rejected", problem: { code: "turn-not-active", projectId } };
  }

  if (!ownsTurn(claim)) {
    return { kind: "rejected", problem: { code: "turn-lease-lost", projectId } };
  }

  return { kind: "abandoned" };
}

export function assertNever(value: never): never {
  throw new Error(`unexpected thread decision: ${JSON.stringify(value)}`);
}
