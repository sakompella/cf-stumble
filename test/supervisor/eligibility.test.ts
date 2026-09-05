/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  deriveGenerationEligibility,
  selectFallbackGeneration,
} from "../../src/supervisor/eligibility.js";
import type { GenerationEligibilityEvidence } from "../../src/supervisor/eligibility.js";
import type { RelayAttempt } from "../../src/supervisor/relay/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  activateGeneration,
  artifact,
  prepareGeneration,
  submitCandidate,
} from "./helpers.js";

import {
  completedAttempt,
  eligibility,
  generationLabel,
  pendingAttempt,
  relayAttempt,
  startupCheck,
} from "./eligibility-fixtures.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function relayCandidateArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/facet/relay/error-status") {
      return new Response("failure body", { status: 500 });
    }
    if (path === "/facet/relay/body-complete") {
      return new Response("complete body");
    }
    return new Response("ready");
  }
}
`,
  );
}

afterEach(async () => {
  await reset();
});

const fallbackPolicy = { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 };

function fallbackCandidate(
  label: number,
  attempts: readonly RelayAttempt[] = [],
): GenerationEligibilityEvidence {
  const generation = generationLabel(label);
  return {
    generationLabel: generation,
    latestActivationId: 4,
    latestPreparationCheck: { ...startupCheck, generationLabel: generation },
    attempts,
  };
}

function eligibleFallbackCandidate(label: number): GenerationEligibilityEvidence {
  const generation = generationLabel(label);
  return fallbackCandidate(label, [
    relayAttempt(1, "body-completed", 200, 0, { generationLabel: generation }),
  ]);
}

test("selects the newest eligible fallback generation", () => {
  expect(
    selectFallbackGeneration(
      generationLabel(3),
      [eligibleFallbackCandidate(1), eligibleFallbackCandidate(2)],
      fallbackPolicy,
    ),
  ).toBe(generationLabel(2));
});

test("skips the failed generation even when it is eligible", () => {
  expect(
    selectFallbackGeneration(
      generationLabel(2),
      [eligibleFallbackCandidate(1), eligibleFallbackCandidate(2)],
      fallbackPolicy,
    ),
  ).toBe(generationLabel(1));
});

test("skips ineligible fallback generations", () => {
  expect(
    selectFallbackGeneration(
      generationLabel(3),
      [eligibleFallbackCandidate(1), fallbackCandidate(2)],
      fallbackPolicy,
    ),
  ).toBe(generationLabel(1));
});

test("returns undefined when no fallback generation qualifies", () => {
  expect(
    selectFallbackGeneration(
      generationLabel(3),
      [fallbackCandidate(1), fallbackCandidate(2)],
      fallbackPolicy,
    ),
  ).toBeUndefined();
});

test("requires credited turns to span time instead of arriving in one burst", () => {
  const burst = eligibility([
    completedAttempt(1, 0),
    completedAttempt(2, 1_000),
    completedAttempt(3, 2_000),
  ]);
  const spread = eligibility([
    completedAttempt(1, 0),
    completedAttempt(2, 1_000),
    completedAttempt(3, 60_000),
  ]);

  expect(burst).toMatchObject({ kind: "ineligible", reason: "insufficient-observation-span" });
  expect(spread).toMatchObject({ kind: "eligible", creditedTurns: 3, observationSpanMs: 60_000 });
});

test("treats pending, completed 4xx, cancellation, and abandonment as neutral attempts", () => {
  const result = deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      attempts: [
        pendingAttempt(1),
        completedAttempt(2, 10),
        relayAttempt(3, "body-completed", 404, 30),
        relayAttempt(4, "relay-cancelled", 200, 40),
        relayAttempt(5, "bounded-abandonment", undefined, 50),
      ],
    },
    { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 },
  );

  expect(result).toMatchObject({ kind: "eligible", creditedTurns: 1, observationSpanMs: 0 });
});

test.each([
  ["pre-header failure", "pre-header-failure", undefined],
  ["body failure", "body-failed", 200],
  ["completed 5xx", "body-completed", 500],
] as const)("revokes eligibility for a %s terminal attempt", (_, outcome, responseStatus) => {
  const result = eligibility([
    completedAttempt(1, 0),
    relayAttempt(2, outcome, responseStatus, 60_000),
    completedAttempt(3, 120_000),
  ]);

  expect(result).toMatchObject({
    kind: "ineligible",
    reason: "failure-observed",
    creditedTurns: 2,
    observationSpanMs: 120_000,
  });
});

test("uses only matching current-era attempts and terminal finish times", () => {
  const attempts: readonly RelayAttempt[] = [
    completedAttempt(2, 60_000),
    pendingAttempt(1),
    completedAttempt(1, 0),
    relayAttempt(3, "body-completed", 200, 120_000, { preparationCheckId: 8 }),
    relayAttempt(4, "body-completed", 200, 120_000, { activationId: 3 }),
    relayAttempt(5, "body-completed", 200, 120_000, { generationLabel: generationLabel(2) }),
  ];
  const strictPolicy = { minimumCreditedTurns: 2, minimumObservationSpanMs: 60_000 };

  const currentEra = deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      attempts,
    },
    strictPolicy,
  );
  expect(currentEra).toMatchObject({
    kind: "eligible",
    creditedTurns: 2,
    observationSpanMs: 60_000,
  });
});

test("qualifies a no-longer-active generation from its retained most recent era", async () => {
  const control = supervisor("eligibility-inactive-generation");
  await activateFixtureGeneration(control);
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
  const label = await submitCandidate(control, "0123456789abcdef0123456789abcdef01234567");
  await prepareGeneration(control, label, "0123456789abcdef0123456789abcdef01234567");
  await activateGeneration(control, label);

  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "eligible", creditedTurns: 1 });
});

test("rejects a generation when its most recent era fails after an older era succeeded", async () => {
  const control = supervisor("eligibility-latest-era-failure");
  await activateFixtureGeneration(control);
  const completion = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await completion.text();
  const label = await submitCandidate(control, "0123456789abcdef0123456789abcdef01234567");
  await prepareGeneration(control, label, "0123456789abcdef0123456789abcdef01234567");
  await activateGeneration(control, label);
  await activateGeneration(control, 0);
  const failure = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/error-status"),
  );
  await failure.text();

  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "failure-observed" });
});

test("requires a fresh passing startup check after a failure observation", async () => {
  const control = supervisor("eligibility-fresh-startup-check");
  const harnessCommit = "c123456789abcdef0123456789abcdef01234567";
  const label = await submitCandidate(control, harnessCommit);

  const candidateArtifact = relayCandidateArtifact(harnessCommit);
  const firstStartup = await control.checkGenerationStartup(label, candidateArtifact);
  if (!firstStartup.ok) {
    throw new Error("a valid candidate must produce a startup-check report");
  }
  await activateGeneration(control, label);

  const failure = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/error-status"),
  );
  await failure.text();
  const strictPolicy = { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 };

  expect(await control.getGenerationEligibility(label, strictPolicy)).toMatchObject({
    kind: "ineligible",
    reason: "failure-observed",
  });

  const freshStartup = await control.checkGenerationStartup(label, candidateArtifact);
  if (!freshStartup.ok) {
    throw new Error("a fresh startup check must produce a report");
  }

  const completion = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await completion.text();

  expect(await control.getGenerationEligibility(label, strictPolicy)).toMatchObject({
    kind: "eligible",
    creditedTurns: 1,
  });
});
