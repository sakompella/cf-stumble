import { invariant } from "../invariant.js";
import { parseGenerationLabel } from "./generations/index.js";
import type { GenerationLabel } from "./generations/index.js";
import type { PreparationCheck } from "./generations/index.js";
import type { RelayAttempt } from "./relay/index.js";

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
  readonly attempts: readonly RelayAttempt[];
};

type CreditedAttempt = RelayAttempt & {
  readonly outcome: "body-completed";
  readonly responseStatus: number;
  readonly finishedAt: number;
};

export function selectFallbackGeneration(
  failedGenerationLabel: GenerationLabel,
  candidates: readonly GenerationEligibilityEvidence[],
  policy: EligibilityPolicy,
): GenerationLabel | undefined {
  return candidates
    .toReversed()
    .find(
      (candidate) =>
        candidate.generationLabel !== failedGenerationLabel &&
        deriveGenerationEligibility(candidate, policy).kind === "eligible",
    )?.generationLabel;
}

/** The generation history this derivation reads. `Generations` satisfies it. */
export interface GenerationEvidenceHistory {
  latestActivationId(label: GenerationLabel): number | undefined;
  latestPreparationCheck(label: GenerationLabel): PreparationCheck | undefined;
}

/**
 * Collect one generation's evidence and derive its verdict. A label that is not a generation label
 * has no evidence at all, so it reports the same `startup-check-required` an unchecked generation
 * reports rather than failing the call.
 */
export function generationEligibility(
  label: number,
  history: GenerationEvidenceHistory,
  attempts: readonly RelayAttempt[],
  policy: EligibilityPolicy,
): GenerationEligibility {
  const generationLabel = parseGenerationLabel(label);
  if (generationLabel === undefined) {
    return ineligible("startup-check-required", 0, 0);
  }

  return deriveGenerationEligibility(
    {
      generationLabel,
      latestActivationId: history.latestActivationId(generationLabel),
      latestPreparationCheck: history.latestPreparationCheck(generationLabel),
      attempts,
    },
    policy,
  );
}

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

  const attempts = evidence.attempts.filter((attempt) =>
    belongsToMostRecentEra(attempt, evidence.generationLabel, activationId, preparationCheck),
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
  attempt: RelayAttempt,
  generationLabel: GenerationLabel,
  activationId: number,
  preparationCheck: PreparationCheck,
): boolean {
  return (
    attempt.generationLabel === generationLabel &&
    attempt.activationId === activationId &&
    attempt.preparationCheckId === preparationCheck.id
  );
}

function isCreditedTurn(attempt: RelayAttempt): attempt is CreditedAttempt {
  return attempt.outcome === "body-completed" && attempt.responseStatus < 400;
}

function isFailureObservation(attempt: RelayAttempt): boolean {
  return (
    attempt.outcome === "pre-header-failure" ||
    attempt.outcome === "body-failed" ||
    (attempt.outcome === "body-completed" && attempt.responseStatus >= 500)
  );
}

function creditedSpan(attempts: readonly CreditedAttempt[]): number {
  return attempts.length < 2
    ? 0
    : Math.max(...attempts.map((attempt) => attempt.finishedAt)) -
        Math.min(...attempts.map((attempt) => attempt.finishedAt));
}

function ineligible(
  reason: Extract<GenerationEligibility, { readonly kind: "ineligible" }>["reason"],
  creditedTurns: number,
  observationSpanMs: number,
): GenerationEligibility {
  return { kind: "ineligible", reason, creditedTurns, observationSpanMs };
}

function validatePolicy(policy: EligibilityPolicy): void {
  invariant(
    Number.isSafeInteger(policy.minimumCreditedTurns) && policy.minimumCreditedTurns >= 1,
    "minimumCreditedTurns must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.minimumObservationSpanMs) && policy.minimumObservationSpanMs >= 0,
    "minimumObservationSpanMs must be a non-negative safe integer",
  );
}
