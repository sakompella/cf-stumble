/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { deriveGenerationEligibility } from "../../src/supervisor/eligibility.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { ActiveGeneration } from "../../src/supervisor/generations.js";
import type { PreparationCheck } from "../../src/supervisor/preparation-checks.js";
import type { RelayAttempt } from "../../src/supervisor/relay-facts.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

const policy: EligibilityPolicy = {
  minimumCreditedTurns: 3,
  minimumObservationSpanMs: 60_000,
};

const active: ActiveGeneration = {
  generation: {
    label: 1,
    harnessCommit: "0123456789abcdef0123456789abcdef01234567",
    status: "ready",
  },
  epoch: 4,
};

const startupCheck: PreparationCheck = { id: 9, generationLabel: 1, outcome: "passed" };

function completedAttempt(id: number, finishedAt: number): RelayAttempt {
  return {
    id,
    generationLabel: 1,
    activationEpoch: 4,
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
    { generationLabel: 1, active, latestPreparationCheck: startupCheck, attempts },
    policy,
  );
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function artifact(harnessCommit: string) {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      {
        name: "main.js",
        source: `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("ready"); }
}
`,
      },
    ],
  };
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

test("requires a fresh passing startup check after a failure observation", async () => {
  const control = supervisor("eligibility-fresh-startup-check");
  const harnessCommit = "0123456789abcdef0123456789abcdef01234567";
  const labeled = await control.labelGeneration(harnessCommit);
  if (!labeled.ok) {
    throw new Error("a valid harness commit must receive a generation label");
  }

  const firstStartup = await control.checkGenerationStartup(
    labeled.generation.label,
    artifact(harnessCommit),
  );
  if (!firstStartup.ok) {
    throw new Error("a valid candidate must produce a startup-check report");
  }
  await control.activateGeneration(labeled.generation.label);

  const failure = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/error-status"),
  );
  await failure.text();
  const strictPolicy = { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 };

  expect(
    await control.getGenerationEligibility(labeled.generation.label, strictPolicy),
  ).toMatchObject({
    kind: "ineligible",
    reason: "failure-observed",
  });

  const freshStartup = await control.checkGenerationStartup(
    labeled.generation.label,
    artifact(harnessCommit),
  );
  if (!freshStartup.ok) {
    throw new Error("a fresh startup check must produce a report");
  }

  const completion = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await completion.text();

  expect(
    await control.getGenerationEligibility(labeled.generation.label, strictPolicy),
  ).toMatchObject({
    kind: "eligible",
    creditedTurns: 1,
  });
});
