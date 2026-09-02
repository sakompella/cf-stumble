import type { SessionDocument, SessionProblem, SessionRecord } from "./session.js";

/**
 * Pure deciders for the session store. Each takes the current record (or undefined for a session
 * that has never been written) and returns a plain decision. The imperative shell in index.ts
 * reads the record, calls a decider, and applies the effect the decision names inside one Durable
 * Object transaction, so the record cannot change between the read and the write.
 *
 * A turn holds the session until its deadline. The facet that starts a turn can die before it
 * finishes, and nothing else would ever release the slot, so admission treats a turn whose
 * deadline has passed as free and lets the next caller take it over. `relay_attempts` bounds a
 * relay the same way rather than waiting on a caller that may never return.
 */

function holdsTurn(current: SessionRecord | undefined, now: number): boolean {
  return current?.turnActive === true && (current.turnDeadlineAt ?? 0) > now;
}

export type StartTurnDecision =
  | { readonly kind: "rejected"; readonly problem: SessionProblem }
  | {
      readonly kind: "started";
      readonly revision: number;
      readonly document: SessionDocument | undefined;
    };

export function decideStartTurn(
  sessionId: string,
  current: SessionRecord | undefined,
  expectedRevision: number,
  now: number,
): StartTurnDecision {
  if (holdsTurn(current, now)) {
    return {
      kind: "rejected",
      problem: { code: "turn-conflict", sessionId, deadlineAt: current?.turnDeadlineAt ?? 0 },
    };
  }

  const revision = current?.revision ?? 0;
  if (expectedRevision !== revision) {
    return {
      kind: "rejected",
      problem: { code: "stale-revision", sessionId, currentRevision: revision },
    };
  }

  return { kind: "started", revision, document: current?.document };
}

export type FinishTurnDecision =
  | { readonly kind: "rejected"; readonly problem: SessionProblem }
  | { readonly kind: "finished"; readonly nextRevision: number };

export function decideFinishTurn(
  sessionId: string,
  current: SessionRecord | undefined,
  expectedRevision: number,
  now: number,
): FinishTurnDecision {
  if (current === undefined || !current.turnActive) {
    return { kind: "rejected", problem: { code: "turn-not-active", sessionId } };
  }
  if (!holdsTurn(current, now)) {
    return {
      kind: "rejected",
      problem: { code: "turn-expired", sessionId, deadlineAt: current.turnDeadlineAt ?? 0 },
    };
  }
  if (expectedRevision !== current.revision) {
    return {
      kind: "rejected",
      problem: { code: "stale-revision", sessionId, currentRevision: current.revision },
    };
  }

  return { kind: "finished", nextRevision: current.revision + 1 };
}

export type AbandonTurnDecision =
  | { readonly kind: "rejected"; readonly problem: SessionProblem }
  | {
      readonly kind: "abandoned";
      readonly revision: number;
      readonly document: SessionDocument | undefined;
    };

export function decideAbandonTurn(
  sessionId: string,
  current: SessionRecord | undefined,
): AbandonTurnDecision {
  if (current === undefined || !current.turnActive) {
    return { kind: "rejected", problem: { code: "turn-not-active", sessionId } };
  }

  return { kind: "abandoned", revision: current.revision, document: current.document };
}

export function assertNever(value: never): never {
  throw new Error(`unexpected session decision: ${JSON.stringify(value)}`);
}
