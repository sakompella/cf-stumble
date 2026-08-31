/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import { RelayFacts, type RelayFact } from "../../src/supervisor/relay-facts.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  prepareGeneration,
  readyArtifact,
  submitCandidate,
} from "./startup-check-helpers.js";

import {
  completedFact,
  eligibility,
  generationLabel,
  relayFact,
  startupCheck,
} from "./eligibility-fixtures.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("requires credited turns to span time instead of arriving in one burst", () => {
  const burst = eligibility([
    completedFact(1, 0),
    completedFact(2, 1_000),
    completedFact(3, 2_000),
  ]);
  const spread = eligibility([
    completedFact(1, 0),
    completedFact(2, 1_000),
    completedFact(3, 60_000),
  ]);

  expect(burst).toMatchObject({ kind: "ineligible", reason: "insufficient-observation-span" });
  expect(spread).toMatchObject({ kind: "eligible", creditedTurns: 3, observationSpanMs: 60_000 });
});

test("treats headers, completed 4xx, cancellation, and abandonment as neutral facts", () => {
  const result = deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      facts: [
        relayFact(1, "headers-received", 200, 0),
        completedFact(1, 10),
        relayFact(2, "headers-received", 503, 20),
        relayFact(3, "body-completed", 404, 30),
        relayFact(4, "relay-cancelled", 200, 40),
        relayFact(5, "bounded-abandonment", undefined, 50),
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
] as const)("revokes eligibility for a %s terminal fact", (_, kind, responseStatus) => {
  const result = eligibility([
    completedFact(1, 0),
    relayFact(2, kind, responseStatus, 60_000),
    completedFact(3, 120_000),
  ]);

  expect(result).toMatchObject({
    kind: "ineligible",
    reason: "failure-observed",
    creditedTurns: 2,
    observationSpanMs: 120_000,
  });
});

test("uses only matching current-era facts and terminal timestamps", () => {
  const facts: readonly RelayFact[] = [
    completedFact(2, 60_000),
    relayFact(1, "headers-received", 200, 1_000_000),
    completedFact(1, 0),
    relayFact(3, "body-completed", 200, 120_000, { preparationCheckId: 8 }),
    relayFact(4, "body-completed", 200, 120_000, { activationId: 3 }),
    relayFact(5, "body-completed", 200, 120_000, { generationLabel: generationLabel(2) }),
  ];
  const strictPolicy = { minimumCreditedTurns: 2, minimumObservationSpanMs: 60_000 };

  const currentEra = deriveGenerationEligibility(
    {
      generationLabel: generationLabel(1),
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      facts,
    },
    strictPolicy,
  );
  expect(currentEra).toMatchObject({
    kind: "eligible",
    creditedTurns: 2,
    observationSpanMs: 60_000,
  });
});

test.each([
  [completedFact(1, 0), completedFact(1, 1)],
  [completedFact(1, 0), relayFact(1, "body-failed", 200, 1)],
])("rejects duplicate or contradictory terminal facts for one attempt", (first, second) => {
  expect(() => eligibility([first, second])).toThrow(
    "invalid relay fact history for attempt 1: multiple terminal facts",
  );
});

test("does not credit a completed attempt summary without a terminal fact after eviction", async () => {
  const control = supervisor("eligibility-facts-authoritative");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");

  await runInDurableObject(control, (instance, state) => {
    const active = instance.getActiveGeneration();
    const preparationCheck = instance.getPreparationCheckHistory(0).at(-1);
    if (active.generation === undefined || preparationCheck === undefined) {
      throw new Error("an active generation needs a preparation check");
    }

    const facts = new RelayFacts(state.storage);
    const attempt = facts.start(active, preparationCheck.id, 0, 100);
    state.storage.sql.exec(
      `UPDATE relay_attempts
       SET response_status = 200, outcome = 'body-completed', finished_at = 1
       WHERE id = ?`,
      attempt.id,
    );
  });
  await evictDurableObject(control);

  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "body-completed", responseStatus: 200, finishedAt: 1 },
  ]);
  expect(await control.getRelayFacts()).toEqual([]);
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "insufficient-credited-turns" });
});

test("qualifies a no-longer-active generation from its retained most recent era", async () => {
  const control = supervisor("eligibility-inactive-generation");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
  const label = await submitCandidate(
    control,
    "0123456789abcdef0123456789abcdef01234567",
    "submit-replacement",
  );
  await prepareGeneration(control, label, "0123456789abcdef0123456789abcdef01234567");
  await activateGeneration(control, label, "activate-replacement");

  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "eligible", creditedTurns: 1 });
});

test("rejects a generation when its most recent era fails after an older era succeeded", async () => {
  const control = supervisor("eligibility-latest-era-failure");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const completion = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await completion.text();
  const label = await submitCandidate(
    control,
    "0123456789abcdef0123456789abcdef01234567",
    "submit-replacement",
  );
  await prepareGeneration(control, label, "0123456789abcdef0123456789abcdef01234567");
  await activateGeneration(control, label, "activate-replacement");
  await activateGeneration(control, 0, "reactivate-fixture");
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
  const harnessCommit = "0123456789abcdef0123456789abcdef01234567";
  const label = await submitCandidate(control, harnessCommit, "submit-candidate");

  const firstStartup = await control.checkGenerationStartup(label, readyArtifact(harnessCommit));
  if (!firstStartup.ok) {
    throw new Error("a valid candidate must produce a startup-check report");
  }
  await activateGeneration(control, label, "activate-candidate");

  const failure = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/error-status"),
  );
  await failure.text();
  const strictPolicy = { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 };

  expect(await control.getGenerationEligibility(label, strictPolicy)).toMatchObject({
    kind: "ineligible",
    reason: "failure-observed",
  });

  const freshStartup = await control.checkGenerationStartup(label, readyArtifact(harnessCommit));
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
