/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../src/supervisor/recovery.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./startup-check-helpers.js";

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

async function episodeWithFallback(name: string) {
  const control = await fallbackReady(name);
  const episode = await control.startRecovery(
    { failureEventId: "failure-1", failedGenerationLabel: 1 },
    policy,
    1_000,
    strictEligibility,
  );
  return { control, episode };
}

afterEach(async () => {
  await reset();
});

test("deduplicates a failure event into one recovery episode", async () => {
  const { control, episode } = await episodeWithFallback("recovery-deduplicates-failure");
  const replay = await control.startRecovery(
    { failureEventId: "failure-1", failedGenerationLabel: 1 },
    { ...policy, maxRepairAttempts: 1 },
    2_000,
    strictEligibility,
  );

  expect(replay).toEqual(episode);
  expect(replay.policy.maxRepairAttempts).toBe(2);
});

test("blocks recovery without a qualifying fallback and leaves traffic on its generation", async () => {
  const control = supervisor("recovery-blocked-without-fallback");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const before = await control.getActiveGeneration();
  const episode = await control.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );

  expect(episode).toMatchObject({
    fallbackGenerationLabel: undefined,
    phase: "blocked",
    result: "blocked:no-known-good-generation",
  });
  expect(await control.getActiveGeneration(), "a blocked recovery must not change traffic").toEqual(
    before,
  );
});

test("never chooses the failed generation as its fallback", async () => {
  const control = supervisor("recovery-excludes-failed-generation");
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();

  const episode = await control.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );

  expect(episode.fallbackGenerationLabel).toBeUndefined();
});

test("replays an open repair operation with its original key", async () => {
  const { control, episode } = await episodeWithFallback("recovery-replays-operation-key");
  const first = await control.resumeRecovery(episode.id, 1_000);
  await evictDurableObject(control);
  const replay = await control.resumeRecovery(episode.id, 1_001);

  expect(first.currentOperation).toMatchObject({ key: `recovery-${episode.id}:repair:1` });
  expect(replay).toEqual(first);
  expect(replay.attemptsUsed).toBe(1);
});

test("marks an expired repair operation for reconciliation without opening another", async () => {
  const { control, episode } = await episodeWithFallback("recovery-operation-deadline");
  const opened = await control.resumeRecovery(episode.id, 1_000);
  const deadline = opened.currentOperation?.deadlineAt;
  if (deadline === undefined) {
    throw new Error("resuming a recoverable episode must open a repair operation");
  }
  const expired = await control.resumeRecovery(episode.id, deadline);
  const replay = await control.resumeRecovery(episode.id, deadline + 1);

  expect(expired).toMatchObject({
    phase: "needs-reconciliation",
    errors: ["operation-deadline-exceeded"],
    currentOperation: { key: opened.currentOperation?.key, state: "needs-reconciliation" },
  });
  expect(replay).toEqual(expired);
});

test("ends at the repair-attempt bound while retaining the fallback", async () => {
  const { control, episode } = await episodeWithFallback("recovery-attempt-bound");
  const first = await control.resumeRecovery(episode.id, 1_000);
  const firstKey = first.currentOperation?.key;
  if (firstKey === undefined) {
    throw new Error("the first repair operation must have a key");
  }
  await control.reportRecoveryOperation(
    episode.id,
    firstKey,
    { kind: "failed", error: "first" },
    1_001,
  );
  const second = await control.resumeRecovery(episode.id, 1_002);
  const secondKey = second.currentOperation?.key;
  if (secondKey === undefined) {
    throw new Error("the second repair operation must have a key");
  }
  await control.reportRecoveryOperation(
    episode.id,
    secondKey,
    { kind: "failed", error: "second" },
    1_003,
  );
  const completed = await control.resumeRecovery(episode.id, 1_004);

  expect(completed).toMatchObject({
    fallbackGenerationLabel: 0,
    phase: "completed",
    result: "fallback-retained:repair-attempt-budget-exhausted",
    attemptsUsed: 2,
  });
});

test("ends at the recovery budget while retaining the fallback", async () => {
  const { control, episode } = await episodeWithFallback("recovery-budget-bound");
  const opened = await control.resumeRecovery(episode.id, 1_000);
  const key = opened.currentOperation?.key;
  if (key === undefined) {
    throw new Error("the repair operation must have a key");
  }
  await control.reportRecoveryOperation(
    episode.id,
    key,
    { kind: "failed", error: "failed" },
    1_001,
  );
  const completed = await control.resumeRecovery(episode.id, 1_100);

  expect(completed).toMatchObject({
    fallbackGenerationLabel: 0,
    phase: "completed",
    result: "fallback-retained:recovery-budget-exhausted",
  });
});

test("retains a recovery report after Durable Object eviction", async () => {
  const { control, episode } = await episodeWithFallback("recovery-report-after-eviction");
  const opened = await control.resumeRecovery(episode.id, 1_000);

  await evictDurableObject(control);

  expect(await control.getRecoveryEpisode(episode.id)).toEqual(opened);
});
