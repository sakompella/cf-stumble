import type { PreparationCheck } from "./preparation-checks.js";
import type { RelayAttempt } from "./relay-facts.js";

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
  readonly generationLabel: number;
  readonly latestActivationId: number | undefined;
  readonly latestPreparationCheck: PreparationCheck | undefined;
  readonly attempts: readonly RelayAttempt[];
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

  const currentAttempts = evidence.attempts.filter((attempt) =>
    belongsToMostRecentEra(attempt, evidence.generationLabel, activationId, preparationCheck),
  );
  const credited = currentAttempts.filter((attempt) => isCreditedTurn(attempt));
  const observationSpanMs = creditedSpan(credited);

  if (currentAttempts.some((attempt) => isFailureObservation(attempt))) {
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
  attempt: RelayAttempt,
  generationLabel: number,
  activationId: number,
  preparationCheck: PreparationCheck,
): boolean {
  return (
    attempt.generationLabel === generationLabel &&
    attempt.activationId === activationId &&
    attempt.preparationCheckId === preparationCheck.id
  );
}

function isCreditedTurn(attempt: RelayAttempt): boolean {
  return attempt.outcome === "body-completed" && attempt.responseStatus < 400;
}

function isFailureObservation(attempt: RelayAttempt): boolean {
  return (
    attempt.outcome === "pre-header-failure" ||
    attempt.outcome === "body-failed" ||
    (attempt.outcome === "body-completed" && attempt.responseStatus >= 500)
  );
}

function creditedSpan(attempts: readonly RelayAttempt[]): number {
  if (attempts.length < 2) {
    return 0;
  }

  const times = attempts.map((attempt) => {
    if (attempt.finishedAt === undefined) {
      throw new Error("a credited attempt must have a completion time");
    }

    return attempt.finishedAt;
  });

  return Math.max(...times) - Math.min(...times);
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
