/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryEpisode, RecoveryPolicy } from "../../src/supervisor/recovery.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./startup-check-helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";
const repairedCommit = "b123456789abcdef0123456789abcdef01234567";
const strictEligibility: EligibilityPolicy = {
  minimumCreditedTurns: 1,
  minimumObservationSpanMs: 0,
};
const policy: RecoveryPolicy = {
  maxRepairAttempts: 2,
  recoveryBudgetMs: 100,
  operationDeadlineMs: 10,
};

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function requiredOperation(episode: RecoveryEpisode) {
  if (episode.currentOperation === undefined) {
    throw new Error("a recoverable episode must have an operation");
  }
  return episode.currentOperation;
}

async function fallbackReady(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = supervisor(name);
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
  const replacement = await submitCandidate(control, replacementCommit, "submit-replacement");
  await prepareGeneration(control, replacement, replacementCommit);
  await activateGeneration(control, replacement, "activate-replacement");
  return control;
}

async function startupState(control: DurableObjectStub<Supervisor>) {
  const ready = await control.startRecovery(
    { failureEventId: "ready", failedGenerationLabel: 1 },
    policy,
    1_000,
    strictEligibility,
  );
  const repair = await control.resumeRecovery(ready.id, 1_000);
  const startup = await control.reportRecoveryOperation(
    ready.id,
    requiredOperation(repair).key,
    { kind: "repair-succeeded", repairedHarnessCommit: repairedCommit },
    1_001,
  );
  const operation = requiredOperation(startup.episode);
  const needsReconciliation = await control.resumeRecovery(ready.id, operation.deadlineAt);
  return { ready, repair, startup: startup.episode, operation, needsReconciliation };
}

async function repairReconciliationState(control: DurableObjectStub<Supervisor>) {
  const ready = await control.startRecovery(
    { failureEventId: "repair-reconciliation", failedGenerationLabel: 1 },
    policy,
    2_000,
    strictEligibility,
  );
  const repair = await control.resumeRecovery(ready.id, 2_000);
  return control.resumeRecovery(ready.id, requiredOperation(repair).deadlineAt);
}

async function completedAtAttemptBound(control: DurableObjectStub<Supervisor>) {
  const ready = await control.startRecovery(
    { failureEventId: "attempt-bound", failedGenerationLabel: 1 },
    { ...policy, maxRepairAttempts: 1 },
    3_000,
    strictEligibility,
  );
  const repair = await control.resumeRecovery(ready.id, 3_000);
  await control.reportRecoveryOperation(
    ready.id,
    requiredOperation(repair).key,
    { kind: "repair-failed", error: "repair failed" },
    3_001,
  );
  return control.resumeRecovery(ready.id, 3_002);
}

function expectValidEpisode(episode: RecoveryEpisode): void {
  expect(episode.id).toBeGreaterThan(0);
  switch (episode.phase) {
    case "blocked":
      expect(episode).toMatchObject({
        fallbackGenerationLabel: undefined,
        currentOperation: undefined,
        result: "blocked:no-known-good-generation",
      });
      return;
    case "ready":
      expect(episode.fallbackGenerationLabel).toBeTypeOf("number");
      expect(episode.currentOperation).toBeUndefined();
      expect([
        "fallback-retained:repair-pending",
        "repair-failed",
        "startup-check-failed",
      ]).toContain(episode.result);
      return;
    case "repair-open":
      expect(episode.currentOperation).toMatchObject({ kind: "repair", state: "open" });
      return;
    case "startup-check-open":
      expect(episode.currentOperation).toMatchObject({ kind: "startup-check", state: "open" });
      expect(episode.repairedHarnessCommit).toMatch(/^[0-9a-f]{40}$/u);
      return;
    case "needs-reconciliation":
      expect(episode.currentOperation.state).toBe("needs-reconciliation");
      if (episode.currentOperation.kind === "repair") {
        expect(episode.repairedHarnessCommit).toBeUndefined();
      } else {
        expect(episode.repairedHarnessCommit).toMatch(/^[0-9a-f]{40}$/u);
      }
      return;
    case "completed":
      expect(episode.currentOperation).toBeUndefined();
      if (episode.result === "fallback-retained:repaired-generation-verified") {
        expect(episode.verifiedHarnessCommit).toMatch(/^[0-9a-f]{40}$/u);
        expect(episode.verifiedGenerationLabel).toBeTypeOf("number");
        expect(episode.verifiedPreparationCheckId).toBeGreaterThan(0);
      } else {
        expect(episode.verifiedHarnessCommit).toBeUndefined();
      }
  }
}

afterEach(async () => {
  await reset();
});

test("reports every durable recovery state with a positive identifier and matching fields", async () => {
  const blockedControl = supervisor("recovery-state-blocked");
  await prepareGeneration(blockedControl, 0, fixtureMainHarnessCommit);
  await activateGeneration(blockedControl, 0, "activate-fixture");
  const blocked = await blockedControl.startRecovery(
    { failureEventId: "blocked", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );
  const control = await fallbackReady("recovery-state-variants");
  const startup = await startupState(control);
  const repairNeedsReconciliation = await repairReconciliationState(control);
  const boundCompleted = await completedAtAttemptBound(control);
  const label = await submitCandidate(control, repairedCommit, "submit-repaired-generation");
  await prepareGeneration(control, label, repairedCommit);
  const completed = await control.reconcileRecoveryOperation(
    startup.ready.id,
    startup.operation.key,
    { kind: "startup-check-passed", generationLabel: label },
    1_012,
  );

  for (const episode of [
    blocked,
    startup.ready,
    startup.repair,
    startup.startup,
    startup.needsReconciliation,
    repairNeedsReconciliation,
    boundCompleted,
    completed.episode,
  ]) {
    expectValidEpisode(episode);
  }
});
