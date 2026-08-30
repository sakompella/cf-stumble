/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  prepareGeneration,
  readyArtifact,
  submitCandidate,
} from "./startup-check-helpers.js";

const unrelatedHarnessCommit = "0123456789abcdef0123456789abcdef01234567";

async function completedTurn(control: DurableObjectStub<Supervisor>): Promise<void> {
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
}

afterEach(async () => {
  await reset();
});

test("discards credited turns when a redundant preparation check starts a new era", async () => {
  const control: DurableObjectStub<Supervisor> = env.SUPERVISOR.getByName("evidence-era-recheck");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");

  await completedTurn(control);
  const strictPolicy = { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 };
  expect(await control.getGenerationEligibility(0, strictPolicy)).toMatchObject({
    kind: "eligible",
    creditedTurns: 1,
  });

  const rechecked = await control.checkGenerationStartup(
    0,
    readyArtifact(fixtureMainHarnessCommit),
  );
  if (!rechecked.ok) {
    throw new Error("a repeated passing check must be accepted");
  }

  expect(
    rechecked.report.effect,
    "the store reports no effect even though the check resets the evidence era",
  ).toBe("no-op");
  expect(
    await control.getGenerationEligibility(0, strictPolicy),
    "clearing a failure observation and discarding good evidence are the same act today",
  ).toMatchObject({ kind: "ineligible", creditedTurns: 0 });
});

test("keeps a generation's credited turns when unrelated protected state changes", async () => {
  const control: DurableObjectStub<Supervisor> = env.SUPERVISOR.getByName("evidence-era");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");

  await completedTurn(control);
  await submitCandidate(control, unrelatedHarnessCommit, "submit-unrelated");

  await completedTurn(control);
  await completedTurn(control);

  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 3,
      minimumObservationSpanMs: 0,
    }),
    "labeling another commit is not a new activation and must not restart the evidence era",
  ).toMatchObject({ kind: "eligible", creditedTurns: 3 });
});
