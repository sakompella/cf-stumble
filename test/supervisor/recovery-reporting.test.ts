/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../src/supervisor/recovery.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";
const repairedCommit = "b123456789abcdef0123456789abcdef01234567";
const otherCommit = "c123456789abcdef0123456789abcdef01234567";
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

async function startupCheckOpen(name: string, reportRepairStageMismatch = false) {
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
  const repair = await control.resumeRecovery(episode.id, 1_000);
  const repairKey = repair.currentOperation?.key;
  if (repairKey === undefined) {
    throw new Error("a recoverable episode must open repair");
  }
  const repairStageMismatch = reportRepairStageMismatch
    ? await control.reportRecoveryOperation(
        episode.id,
        repairKey,
        { kind: "startup-check-passed", generationLabel: 0 },
        1_001,
      )
    : undefined;
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
  return { control, episode, operation, repair, repairStageMismatch, startup: startup.episode };
}

afterEach(async () => {
  await reset();
});

test("rejects a startup result while repair is open", async () => {
  const { repair, repairStageMismatch } = await startupCheckOpen(
    "recovery-repair-stage-mismatch",
    true,
  );

  expect(repairStageMismatch).toEqual({ applied: false, episode: repair });
});

test("leaves open operations unchanged for wrong keys, reconciliation, and stage mismatches", async () => {
  const { control, episode, operation, startup } = await startupCheckOpen(
    "recovery-operation-report-no-ops",
  );

  const wrongKey = await control.reportRecoveryOperation(
    episode.id,
    `${operation.key}:wrong`,
    { kind: "startup-check-failed", error: "ignored" },
    1_002,
  );
  const stillOpen = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-failed", error: "ignored" },
    1_002,
  );
  const stageMismatch = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "repair-succeeded", repairedHarnessCommit: repairedCommit },
    1_002,
  );

  expect(wrongKey).toEqual({ applied: false, episode: startup });
  expect(stillOpen).toEqual({ applied: false, episode: startup });
  expect(stageMismatch).toEqual({ applied: false, episode: startup });
});

test("does not replay reports or reconciliation after completion", async () => {
  const { control, episode, operation } = await startupCheckOpen(
    "recovery-completed-report-replay",
  );
  const label = await submitCandidate(control, repairedCommit, "submit-repaired-generation");
  await prepareGeneration(control, label, repairedCommit);
  const completed = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: label },
    1_002,
  );

  const replayedReport = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-failed", error: "ignored" },
    1_003,
  );
  const replayedReconciliation = await control.reconcileRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-failed", error: "ignored" },
    1_003,
  );

  expect(replayedReport).toEqual({ applied: false, episode: completed.episode });
  expect(replayedReconciliation).toEqual({ applied: false, episode: completed.episode });
});

test("rejects startup passes for the wrong repaired commit or generation label", async () => {
  const { control, episode, operation, startup } = await startupCheckOpen(
    "recovery-rejects-wrong-candidate",
  );
  const otherLabel = await submitCandidate(control, otherCommit, "submit-other-generation");
  await prepareGeneration(control, otherLabel, otherCommit);

  const wrongCommit = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: otherLabel },
    1_002,
  );
  const repairedLabel = await submitCandidate(
    control,
    repairedCommit,
    "submit-repaired-generation",
  );
  await prepareGeneration(control, repairedLabel, repairedCommit);
  const wrongGeneration = await control.reportRecoveryOperation(
    episode.id,
    operation.key,
    { kind: "startup-check-passed", generationLabel: 0 },
    1_003,
  );

  expect(wrongCommit).toEqual({ applied: false, episode: startup });
  expect(wrongGeneration).toEqual({ applied: false, episode: startup });
});
