/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/index.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../src/supervisor/recovery.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./helpers.js";

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

async function episodeWithFallback(name: string) {
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
  const episode = await control.startRecovery(
    { failureEventId: "failure-1", failedGenerationLabel: replacement },
    policy,
    1_000,
    strictEligibility,
  );
  return { control, episode };
}

async function expiredRepair(name: string) {
  const { control, episode } = await episodeWithFallback(name);
  const opened = await control.resumeRecovery(episode.id, 1_000);
  const operation = opened.currentOperation;
  if (operation === undefined) {
    throw new Error("a recoverable episode must open repair");
  }
  const expired = await control.resumeRecovery(episode.id, operation.deadlineAt);
  return { control, episode, operation, expired };
}

async function expiredStartupCheck(name: string) {
  const { control, episode } = await episodeWithFallback(name);
  const repair = await control.resumeRecovery(episode.id, 1_000);
  const repairKey = repair.currentOperation?.key;
  if (repairKey === undefined) {
    throw new Error("a recoverable episode must open repair");
  }
  const startup = await control.reportRecoveryOperation(
    episode.id,
    repairKey,
    { kind: "repair-succeeded", repairedHarnessCommit: repairedCommit },
    1_001,
  );
  const operation = startup.episode.currentOperation;
  if (operation === undefined) {
    throw new Error("a successful repair must open a startup check");
  }
  await control.resumeRecovery(episode.id, operation.deadlineAt);
  return { control, episode, operation };
}

afterEach(async () => {
  await reset();
});

test("reconciles a repair failure back to ready", async () => {
  const { control, episode, operation } = await expiredRepair("recovery-reconcile-repair-failure");

  const reconciled = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-failed", error: "repair failed after timeout" },
    1_011,
  );

  expect(reconciled).toMatchObject({
    applied: true,
    episode: {
      phase: "ready",
      result: "repair-failed",
      currentOperation: undefined,
      errors: ["operation-deadline-exceeded", "repair failed after timeout"],
    },
  });
});

test("does not apply the same reconciliation twice", async () => {
  const { control, episode, operation } = await expiredRepair("recovery-reconcile-replay");
  const first = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-failed", error: "repair failed after timeout" },
    1_011,
  );
  const replay = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-failed", error: "repair failed after timeout" },
    1_012,
  );

  expect(first.applied).toBe(true);
  expect(replay).toEqual({ applied: false, episode: first.episode });
});

test("reconciles a startup-check failure back to ready", async () => {
  const { control, episode, operation } = await expiredStartupCheck(
    "recovery-reconcile-startup-check-failure",
  );

  const reconciled = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-failed", error: "startup check failed after timeout" },
    1_012,
  );

  expect(reconciled).toMatchObject({
    applied: true,
    episode: {
      phase: "ready",
      result: "startup-check-failed",
      currentOperation: undefined,
      errors: ["operation-deadline-exceeded", "startup check failed after timeout"],
    },
  });
});

test("reconciles a verified startup-check pass into completion", async () => {
  const { control, episode, operation } = await expiredStartupCheck(
    "recovery-reconcile-startup-check-success",
  );
  const label = await submitCandidate(control, repairedCommit, "submit-reconciled-generation");
  await prepareGeneration(control, label, repairedCommit);

  const reconciled = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: label },
    1_012,
  );

  expect(reconciled).toMatchObject({
    applied: true,
    episode: {
      phase: "completed",
      result: "fallback-retained:repaired-generation-verified",
      verifiedHarnessCommit: repairedCommit,
      verifiedGenerationLabel: label,
    },
  });
});

test("settles an expired episode's repair under its original key without opening startup", async () => {
  const { control, episode, operation } = await expiredRepair("recovery-reconcile-after-budget");

  const reconciled = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-succeeded", repairedHarnessCommit: repairedCommit },
    1_100,
  );
  const exhausted = await control.resumeRecovery(episode.id, 1_100);

  expect(reconciled).toMatchObject({
    applied: true,
    episode: { phase: "ready", currentOperation: undefined },
  });
  expect(exhausted).toMatchObject({
    phase: "completed",
    result: "fallback-retained:recovery-budget-exhausted",
  });
});

test("reconciles a repair success into its startup check", async () => {
  const { control, episode, operation } = await expiredRepair("recovery-reconcile-repair-success");

  const reconciled = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-succeeded", repairedHarnessCommit: repairedCommit },
    1_011,
  );

  expect(reconciled).toMatchObject({
    applied: true,
    episode: {
      phase: "startup-check-open",
      currentOperation: {
        kind: "startup-check",
        attempt: 1,
        key: `recovery-${episode.id}:startup-check:1`,
      },
    },
  });
});
