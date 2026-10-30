import type { ProjectId } from "../../project-catalog.js";
import type { ProjectThread, ThreadProblem } from "./thread.js";

/**
 * Pure deciders; store.ts applies their decisions in one Durable Object transaction.
 *
 * A turn holds the thread until its deadline: the facet can die before finishing, so admission treats
 * an expired turn as free.
 *
 * Only the lease id minted at admission may finish or abandon its turn. Every commit, abandonment and
 * fresh thread clears it, so a matching id proves the thread has not moved to a replacement turn.
 */

function holdsTurn(current: ProjectThread, now: number): boolean {
  return current.turnActive && (current.turnDeadlineAt ?? 0) > now;
}

export type TurnLeaseClaim = Readonly<{
  held: string | undefined;
  presented: string;
}>;

function ownsTurn(claim: TurnLeaseClaim): boolean {
  return claim.held !== undefined && claim.held === claim.presented;
}

type StartTurnDecision =
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

type FinishTurnDecision =
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

type AbandonTurnDecision =
  | Readonly<{ kind: "rejected"; problem: ThreadProblem }>
  | Readonly<{ kind: "abandoned" }>;

/** Abandoning needs the lease but not a live deadline: a turn past its deadline that nobody took over may still clean up. */
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
