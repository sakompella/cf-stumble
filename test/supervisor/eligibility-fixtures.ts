import { parseGenerationLabel } from "../../src/supervisor/generation-types.js";
import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { PreparationCheck } from "../../src/supervisor/preparation-checks.js";
import type { RelayFact } from "../../src/supervisor/relay-facts.js";

export const policy: EligibilityPolicy = {
  minimumCreditedTurns: 3,
  minimumObservationSpanMs: 60_000,
};

export function generationLabel(value: number) {
  const parsed = parseGenerationLabel(value);
  if (parsed === undefined) {
    throw new Error("test generation labels must be valid");
  }

  return parsed;
}

const startupCheck: PreparationCheck = {
  id: 9,
  generationLabel: generationLabel(1),
  outcome: "passed",
};

type FactAttribution = Partial<
  Pick<RelayFact, "generationLabel" | "activationId" | "preparationCheckId">
>;

export function relayFact(
  attemptId: number,
  kind: RelayFact["kind"],
  responseStatus: number | undefined,
  observedAt: number,
  attribution: FactAttribution = {},
): RelayFact {
  return {
    attemptId,
    generationLabel: generationLabel(1),
    activationId: 4,
    preparationCheckId: 9,
    kind,
    responseStatus,
    observedAt,
    ...attribution,
  };
}

export function completedFact(attemptId: number, observedAt: number, activationId = 4): RelayFact {
  return relayFact(attemptId, "body-completed", 200, observedAt, { activationId });
}

export function eligibility(facts: readonly RelayFact[]) {
  return deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      facts,
    },
    policy,
  );
}

export { startupCheck };
