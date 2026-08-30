import type { GenerationLabel } from "./generation-types.js";
import type { PreparationCheck } from "./preparation-checks.js";
import type { RelayFact } from "./relay-facts.js";

export type EligibilityPolicy = {
  readonly minimumCreditedTurns: number;
  readonly minimumObservationSpanMs: number;
};

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  minimumCreditedTurns: 3,
  minimumObservationSpanMs: 60_000,
};

export type GenerationEligibility =
  | {
      readonly kind: "eligible";
      readonly creditedTurns: number;
      readonly observationSpanMs: number;
    }
  | {
      readonly kind: "ineligible";
      readonly reason:
        | "startup-check-required"
        | "failure-observed"
        | "insufficient-credited-turns"
        | "insufficient-observation-span";
      readonly creditedTurns: number;
      readonly observationSpanMs: number;
    };

export type GenerationEligibilityEvidence = {
  readonly generationLabel: GenerationLabel;
  readonly latestActivationId: number | undefined;
  readonly latestPreparationCheck: PreparationCheck | undefined;
  readonly facts: readonly RelayFact[];
};

type AttemptEvidence = {
  readonly attemptId: number;
  readonly terminalFact: RelayFact | undefined;
};

export function deriveGenerationEligibility(
  evidence: GenerationEligibilityEvidence,
  policy: EligibilityPolicy,
): GenerationEligibility {
  validatePolicy(policy);
  const preparationCheck = evidence.latestPreparationCheck;
  const activationId = evidence.latestActivationId;
  if (preparationCheck === undefined || activationId === undefined) {
    return ineligible("startup-check-required", 0, 0);
  }

  const attempts = foldAttempts(
    evidence.facts.filter((fact) =>
      belongsToMostRecentEra(fact, evidence.generationLabel, activationId, preparationCheck),
    ),
  );
  const credited = attempts.filter((attempt) => isCreditedTurn(attempt));
  const observationSpanMs = creditedSpan(credited);

  if (attempts.some((attempt) => isFailureObservation(attempt))) {
    return ineligible("failure-observed", credited.length, observationSpanMs);
  }

  if (credited.length < policy.minimumCreditedTurns) {
    return ineligible("insufficient-credited-turns", credited.length, observationSpanMs);
  }

  if (observationSpanMs < policy.minimumObservationSpanMs) {
    return ineligible("insufficient-observation-span", credited.length, observationSpanMs);
  }

  return { kind: "eligible", creditedTurns: credited.length, observationSpanMs };
}

function belongsToMostRecentEra(
  fact: RelayFact,
  generationLabel: GenerationLabel,
  activationId: number,
  preparationCheck: PreparationCheck,
): boolean {
  return (
    fact.generationLabel === generationLabel &&
    fact.activationId === activationId &&
    fact.preparationCheckId === preparationCheck.id
  );
}

function foldAttempts(facts: readonly RelayFact[]): readonly AttemptEvidence[] {
  const attempts = new Map<number, AttemptEvidence>();

  for (const fact of facts) {
    validateFact(fact);
    const attempt = attempts.get(fact.attemptId) ?? {
      attemptId: fact.attemptId,
      terminalFact: undefined,
    };

    if (isTerminal(fact)) {
      if (attempt.terminalFact !== undefined) {
        throw new Error(
          `invalid relay fact history for attempt ${fact.attemptId}: multiple terminal facts`,
        );
      }

      attempts.set(fact.attemptId, { ...attempt, terminalFact: fact });
    } else {
      attempts.set(fact.attemptId, attempt);
    }
  }

  return [...attempts.values()];
}

function isTerminal(fact: RelayFact): boolean {
  return fact.kind !== "headers-received";
}

function validateFact(fact: RelayFact): void {
  if (fact.kind === "headers-received" && fact.responseStatus === undefined) {
    throw new Error(`invalid relay fact for attempt ${fact.attemptId}: headers require a status`);
  }

  if (
    (fact.kind === "body-completed" || fact.kind === "body-failed") &&
    fact.responseStatus === undefined
  ) {
    throw new Error(
      `invalid relay fact for attempt ${fact.attemptId}: body terminal requires a status`,
    );
  }

  if (fact.kind === "pre-header-failure" && fact.responseStatus !== undefined) {
    throw new Error(
      `invalid relay fact for attempt ${fact.attemptId}: pre-header failure has a status`,
    );
  }
}

function isCreditedTurn(attempt: AttemptEvidence): boolean {
  const fact = attempt.terminalFact;
  return (
    fact?.kind === "body-completed" &&
    fact.responseStatus !== undefined &&
    fact.responseStatus < 400
  );
}

function isFailureObservation(attempt: AttemptEvidence): boolean {
  const fact = attempt.terminalFact;
  return (
    fact?.kind === "pre-header-failure" ||
    fact?.kind === "body-failed" ||
    (fact?.kind === "body-completed" &&
      fact.responseStatus !== undefined &&
      fact.responseStatus >= 500)
  );
}

function creditedSpan(attempts: readonly AttemptEvidence[]): number {
  const times = attempts
    .map((attempt) => attempt.terminalFact?.observedAt)
    .filter((observedAt): observedAt is number => observedAt !== undefined);

  return times.length < 2 ? 0 : Math.max(...times) - Math.min(...times);
}

function ineligible(
  reason: Extract<GenerationEligibility, { readonly kind: "ineligible" }>["reason"],
  creditedTurns: number,
  observationSpanMs: number,
): GenerationEligibility {
  return { kind: "ineligible", reason, creditedTurns, observationSpanMs };
}

function validatePolicy(policy: EligibilityPolicy): void {
  if (!Number.isSafeInteger(policy.minimumCreditedTurns) || policy.minimumCreditedTurns < 1) {
    throw new Error("minimumCreditedTurns must be a positive safe integer");
  }

  if (
    !Number.isSafeInteger(policy.minimumObservationSpanMs) ||
    policy.minimumObservationSpanMs < 0
  ) {
    throw new Error("minimumObservationSpanMs must be a non-negative safe integer");
  }
}
