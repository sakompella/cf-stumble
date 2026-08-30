/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { PreparationCheck } from "../../src/supervisor/preparation-checks.js";
import type { RelayAttempt } from "../../src/supervisor/relay-facts.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  prepareGeneration,
  readyArtifact,
  submitCandidate,
} from "./startup-check-helpers.js";

const policy: EligibilityPolicy = {
  minimumCreditedTurns: 3,
  minimumObservationSpanMs: 60_000,
};

const startupCheck: PreparationCheck = { id: 9, generationLabel: 1, outcome: "passed" };

function completedAttempt(id: number, finishedAt: number, activationId = 4): RelayAttempt {
  return {
    id,
    generationLabel: 1,
    activationId,
    preparationCheckId: 9,
    startedAt: finishedAt,
    deadlineAt: finishedAt + 1,
    outcome: "body-completed",
    responseStatus: 200,
    finishedAt,
  };
}

function eligibility(attempts: readonly RelayAttempt[]) {
  return deriveGenerationEligibility(
    {
      generationLabel: 1,
      latestActivationId: 4,
      latestPreparationCheck: startupCheck,
      attempts,
    },
    policy,
  );
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
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
