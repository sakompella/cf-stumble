import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { RelayAttempt } from "../../src/supervisor/relay-types.js";
import { generationLabel, policy, relayAttempt, startupCheck } from "./eligibility-fixtures.js";

const terminalOutcomes = [
  "pre-header-failure",
  "body-completed",
  "body-failed",
  "relay-cancelled",
  "bounded-abandonment",
] as const;

const currentEraAttempts = gs.composite<readonly RelayAttempt[]>((tc) => {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
  const attempts: RelayAttempt[] = [];
  for (let attemptId = 1; attemptId <= count; attemptId += 1) {
    const outcome = tc.draw(gs.sampledFrom(terminalOutcomes));
    const responseStatus =
      outcome === "pre-header-failure" || outcome === "bounded-abandonment"
        ? undefined
        : tc.draw(gs.sampledFrom([200, 404, 500]));
    attempts.push(relayAttempt(attemptId, outcome, responseStatus, tc.draw(gs.integers())));
  }
  return attempts;
});

function eligibilityFor(attempts: readonly RelayAttempt[]) {
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

function foreignAttempt(
  attempt: RelayAttempt,
  era: "generation" | "activation" | "check",
): RelayAttempt {
  if (era === "generation") {
    return { ...attempt, generationLabel: generationLabel(2) };
  }
  if (era === "activation") {
    return { ...attempt, activationId: 5 };
  }
  return { ...attempt, preparationCheckId: 10 };
}

test("derives eligibility independently of valid attempt order", () => {
  hegel.test((tc) => {
    const attempts = tc.draw(currentEraAttempts);

    expect(eligibilityFor(attempts.toReversed())).toEqual(eligibilityFor(attempts));
  });
});

test("ignores attempts attributed to another generation, activation, or preparation check", () => {
  hegel.test((tc) => {
    const current = tc.draw(currentEraAttempts);
    const foreign = foreignAttempt(
      relayAttempt(100, "body-failed", 500, tc.draw(gs.integers())),
      tc.draw(gs.sampledFrom(["generation", "activation", "check"] as const)),
    );

    expect(eligibilityFor([...current, foreign])).toEqual(eligibilityFor(current));
  });
});
