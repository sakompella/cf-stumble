/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/index.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../src/supervisor/recovery/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";
const strictEligibility: EligibilityPolicy = {
  minimumCreditedTurns: 1,
  minimumObservationSpanMs: 0,
};
const recoveryPolicy: RecoveryPolicy = {
  maxRepairAttempts: 1,
  recoveryBudgetMs: 100,
  operationDeadlineMs: 10,
};

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

async function readyReplacement(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = supervisor(name);
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const label = await submitCandidate(control, replacementCommit, "submit-replacement");
  await prepareGeneration(control, label, replacementCommit);
  return control;
}

async function activateReplacement(control: DurableObjectStub<Supervisor>, observedEpoch: number) {
  const generation = await control.getGeneration(1);
  if (generation === undefined) {
    throw new Error("the replacement generation must be labeled");
  }

  return control.controlGeneration({
    requestId: "activate-replacement",
    principal: { kind: "user" },
    command: { kind: "activate", label: generation.label, observedEpoch },
  });
}

async function completedTurn(control: DurableObjectStub<Supervisor>): Promise<void> {
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
}

async function epochOf(control: DurableObjectStub<Supervisor>): Promise<number> {
  return (await control.getActiveGeneration()).epoch;
}

afterEach(async () => {
  await reset();
});

test("keeps the activation epoch stable while relaying a completed turn", async () => {
  const control = await readyReplacement("epoch-scope-relay");
  const beforeRelay = await control.getActiveGeneration();

  await completedTurn(control);

  expect(await control.getActiveGeneration()).toEqual(beforeRelay);
  expect(await control.getRelayAttempts()).toMatchObject([
    { generationLabel: 0, outcome: "body-completed", responseStatus: 200 },
  ]);
  const activated = await activateReplacement(control, beforeRelay.epoch);
  expect(activated).toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label: 1 } },
  });
});

test("keeps the activation epoch stable when a rejected request is journaled", async () => {
  const control = await readyReplacement("epoch-scope-rejected-request");
  const beforeRejection = await control.getActiveGeneration();

  const rejected = await control.controlGeneration({
    requestId: "rejected-unknown-generation",
    principal: { kind: "user" },
    command: { kind: "activate", label: 99, observedEpoch: beforeRejection.epoch },
  });

  expect(rejected).toEqual({ ok: false, problem: { code: "unknown-generation" } });
  expect(await control.getActiveGeneration()).toEqual(beforeRejection);

  const corrected = await activateReplacement(control, beforeRejection.epoch);
  expect(corrected).toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label: 1 } },
  });
});

test("keeps the activation epoch stable across durable recovery episode writes", async () => {
  const control = await readyReplacement("epoch-scope-recovery");
  await completedTurn(control);
  await activateReplacement(control, await epochOf(control));
  const beforeRecovery = await control.getActiveGeneration();
  const epochs = [beforeRecovery.epoch];

  const started = await control.startRecovery(
    { failureEventId: "epoch-scope-failure", failedGenerationLabel: 1 },
    recoveryPolicy,
    1_000,
    strictEligibility,
  );
  epochs.push(await epochOf(control));

  const opened = await control.resumeRecovery(started.id, 1_000);
  epochs.push(await epochOf(control));
  const operation = opened.currentOperation;
  if (operation === undefined) {
    throw new Error("a recoverable episode must open a repair operation");
  }

  const failed = await control.reportRecoveryOperation(
    started.id,
    operation.key,
    { kind: "repair-failed", error: "test failure" },
    1_001,
  );
  epochs.push(await epochOf(control));

  const completed = await control.resumeRecovery(started.id, 1_002);
  epochs.push(await epochOf(control));

  expect(started).toMatchObject({ phase: "ready", fallbackGenerationLabel: 0 });
  expect(opened).toMatchObject({ phase: "repair-open" });
  expect(failed).toMatchObject({ applied: true, episode: { phase: "ready" } });
  expect(completed).toMatchObject({
    phase: "completed",
    result: "fallback-retained:repair-attempt-budget-exhausted",
  });
  expect(epochs.every((epoch) => epoch === beforeRecovery.epoch)).toBe(true);
});
