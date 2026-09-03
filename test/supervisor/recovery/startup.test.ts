/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { EligibilityPolicy } from "../../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../../src/supervisor/recovery/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  activateGeneration,
  prepareGeneration,
  submitCandidate,
} from "../helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";
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
  await activateFixtureGeneration(control);
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

async function startupCheckOpen(name: string, repairedHarnessCommit = replacementCommit) {
  const { control, episode } = await episodeWithFallback(name);
  const repair = await control.resumeRecovery(episode.id, 1_000);
  const repairKey = repair.currentOperation?.key;
  if (repairKey === undefined) {
    throw new Error("resuming a recoverable episode must open a repair operation");
  }
  const startup = await control.reportRecoveryOperation(
    episode.id,
    repairKey,
    { kind: "repair-succeeded", repairedHarnessCommit },
    1_001,
  );
  const operation = startup.episode.currentOperation;
  if (operation === undefined) {
    throw new Error("a successful repair must open a startup check");
  }
  return { control, episode, startup: startup.episode, operation };
}

afterEach(async () => {
  await reset();
});

test("opens a startup check for the same repair attempt after repair succeeds", async () => {
  const { episode, startup } = await startupCheckOpen("recovery-repair-opens-startup-check");

  expect(startup).toMatchObject({
    attemptsUsed: 1,
    phase: "startup-check-open",
    repairedHarnessCommit: replacementCommit,
    currentOperation: {
      kind: "startup-check",
      attempt: 1,
      key: `recovery-${episode.id}:startup-check:1`,
    },
  });
});

test("rejects a startup pass without a post-open durable check", async () => {
  const { control, episode, startup, operation } = await startupCheckOpen(
    "recovery-rejects-stale-startup-pass",
  );

  const reported = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: 1 },
    1_002,
  );

  expect(reported).toEqual({ applied: false, episode: startup });
});

test("completes from a submitted and newly checked repaired generation after eviction", async () => {
  const repairedCommit = "b123456789abcdef0123456789abcdef01234567";
  const { control, episode, operation } = await startupCheckOpen(
    "recovery-verifies-repaired-generation",
    repairedCommit,
  );
  const label = await submitCandidate(control, repairedCommit, "submit-repaired-generation");
  await prepareGeneration(control, label, repairedCommit);

  const completed = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: label },
    1_002,
  );
  await evictDurableObject(control);

  expect(completed).toMatchObject({
    applied: true,
    episode: {
      phase: "completed",
      result: "fallback-retained:repaired-generation-verified",
      verifiedHarnessCommit: repairedCommit,
      verifiedGenerationLabel: label,
    },
  });
  if (
    completed.episode.phase !== "completed" ||
    completed.episode.result !== "fallback-retained:repaired-generation-verified"
  ) {
    throw new Error("a verified startup check must complete recovery");
  }
  expect(completed.episode.verifiedPreparationCheckId).toBeGreaterThan(0);
  expect(await control.getRecoveryEpisode(episode.id)).toEqual(completed.episode);
});

test("returns to ready after a startup failure and opens repair attempt two", async () => {
  const { control, episode, operation } = await startupCheckOpen(
    "recovery-startup-failure-retries-repair",
  );

  const failed = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-failed", error: "candidate did not start" },
    1_002,
  );
  const retry = await control.resumeRecovery(episode.id, 1_003);

  expect(failed).toMatchObject({
    applied: true,
    episode: { phase: "ready", result: "startup-check-failed", currentOperation: undefined },
  });
  expect(retry).toMatchObject({
    attemptsUsed: 2,
    phase: "repair-open",
    currentOperation: { kind: "repair", attempt: 2, key: `recovery-${episode.id}:repair:2` },
  });
});

test("marks an expired startup check for reconciliation under its original key", async () => {
  const { control, episode, operation } = await startupCheckOpen("recovery-startup-check-deadline");

  const expired = await control.resumeRecovery(episode.id, operation.deadlineAt);

  expect(expired).toMatchObject({
    phase: "needs-reconciliation",
    currentOperation: {
      kind: "startup-check",
      key: `recovery-${episode.id}:startup-check:1`,
      state: "needs-reconciliation",
    },
  });
});
