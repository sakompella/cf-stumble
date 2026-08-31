import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { PreparationCheck } from "../../src/supervisor/generations/index.js";
import type { RelayAttempt } from "../../src/supervisor/relay-types.js";

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

type AttemptAttribution = Partial<
  Pick<RelayAttempt, "generationLabel" | "activationId" | "preparationCheckId">
>;

type TerminalOutcome = Exclude<RelayAttempt["outcome"], "pending">;

export function relayAttempt(
  id: number,
  outcome: TerminalOutcome,
  responseStatus: number | undefined,
  finishedAt: number,
  attribution: AttemptAttribution = {},
): RelayAttempt {
  const base = {
    id,
    generationLabel: generationLabel(1),
    activationId: 4,
    preparationCheckId: 9,
    startedAt: 0,
    deadlineAt: 100,
    ...attribution,
  };

  switch (outcome) {
    case "pre-header-failure":
      if (responseStatus !== undefined) {
        throw new Error("pre-header attempt must not have a response status");
      }
      return { ...base, outcome, responseStatus: undefined, finishedAt };
    case "body-completed":
    case "body-failed":
      if (responseStatus === undefined) {
        throw new Error("body attempt must have a response status");
      }
      return { ...base, outcome, responseStatus, finishedAt };
    case "relay-cancelled":
    case "bounded-abandonment":
      return { ...base, outcome, responseStatus, finishedAt };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

export function completedAttempt(
  attemptId: number,
  finishedAt: number,
  activationId = 4,
): RelayAttempt {
  return relayAttempt(attemptId, "body-completed", 200, finishedAt, { activationId });
}

export function pendingAttempt(attemptId: number): RelayAttempt {
  return {
    id: attemptId,
    generationLabel: generationLabel(1),
    activationId: 4,
    preparationCheckId: 9,
    startedAt: 0,
    deadlineAt: 100,
    outcome: "pending",
    responseStatus: undefined,
    finishedAt: undefined,
  };
}

export function eligibility(attempts: readonly RelayAttempt[]) {
  return deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      attempts,
    },
    policy,
  );
}

export { startupCheck };
