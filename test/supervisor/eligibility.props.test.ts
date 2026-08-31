import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { RelayFact } from "../../src/supervisor/relay-facts.js";
import {
  completedFact,
  generationLabel,
  policy,
  relayFact,
  startupCheck,
} from "./eligibility-fixtures.js";

const terminalKinds = [
  "pre-header-failure",
  "body-completed",
  "body-failed",
  "relay-cancelled",
  "bounded-abandonment",
] as const;

const currentEraFacts = gs.composite<readonly RelayFact[]>((tc) => {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
  const facts: RelayFact[] = [];
  for (let attemptId = 1; attemptId <= count; attemptId += 1) {
    const kind = tc.draw(gs.sampledFrom(terminalKinds));
    const responseStatus =
      kind === "pre-header-failure" || kind === "bounded-abandonment"
        ? undefined
        : tc.draw(gs.sampledFrom([200, 404, 500]));
    facts.push(relayFact(attemptId, kind, responseStatus, tc.draw(gs.integers())));
  }
  return facts;
});

function eligibilityFor(facts: readonly RelayFact[]) {
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

function foreignFact(fact: RelayFact, era: "generation" | "activation" | "check"): RelayFact {
  if (era === "generation") {
    return { ...fact, generationLabel: generationLabel(2) };
  }
  if (era === "activation") {
    return { ...fact, activationId: 5 };
  }
  return { ...fact, preparationCheckId: 10 };
}

test("derives eligibility independently of valid fact order", () => {
  hegel.test((tc) => {
    const facts = tc.draw(currentEraFacts);

    expect(eligibilityFor(facts.toReversed())).toEqual(eligibilityFor(facts));
  });
});

test("ignores facts attributed to another generation, activation, or preparation check", () => {
  hegel.test((tc) => {
    const current = tc.draw(currentEraFacts);
    const foreign = foreignFact(
      relayFact(100, "body-failed", 500, tc.draw(gs.integers())),
      tc.draw(gs.sampledFrom(["generation", "activation", "check"] as const)),
    );

    expect(eligibilityFor([...current, foreign])).toEqual(eligibilityFor(current));
  });
});

test("rejects contradictory terminal facts for an attempt in either order", () => {
  hegel.test((tc) => {
    const attemptId = tc.draw(gs.integers({ minValue: 1 }));
    const first = completedFact(attemptId, 0);
    const second = relayFact(attemptId, "body-failed", 500, 1);

    expect(() => eligibilityFor([first, second])).toThrow(/multiple terminal facts/u);
    expect(() => eligibilityFor([second, first])).toThrow(/multiple terminal facts/u);
  });
});
