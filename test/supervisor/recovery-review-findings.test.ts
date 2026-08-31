/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/index.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryEpisode, RecoveryPolicy } from "../../src/supervisor/recovery.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./helpers.js";

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

async function episodeWithFallback(name: string): Promise<{
  readonly control: DurableObjectStub<Supervisor>;
  readonly episode: RecoveryEpisode;
}> {
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
    { failureEventId: "failure-1", failedGenerationLabel: 1 },
    policy,
    1_000,
    strictEligibility,
  );
  return { control, episode };
}

function openRepair(
  control: DurableObjectStub<Supervisor>,
  episode: RecoveryEpisode,
): Promise<RecoveryEpisode> {
  return control.resumeRecovery(episode.id, episode.startedAt);
}

async function openStartupCheck(
  control: DurableObjectStub<Supervisor>,
  episode: RecoveryEpisode,
  repairedHarnessCommit: string,
): Promise<RecoveryEpisode> {
  const repair = await openRepair(control, episode);
  const key = repair.currentOperation?.key;
  if (key === undefined) {
    throw new Error("resuming a recoverable episode must open a repair operation");
  }
  return (
    await control.reportRecoveryOperation(
      episode.id,
      key,
      { kind: "repair-succeeded", repairedHarnessCommit },
      episode.startedAt + 1,
    )
  ).episode;
}

function startupCheckKey(episode: RecoveryEpisode): string {
  const key = episode.currentOperation?.key;
  if (key === undefined) {
    throw new Error("a successful repair must open a startup-check operation");
  }
  return key;
}

function repairKey(episode: RecoveryEpisode): string {
  const key = episode.currentOperation?.key;
  if (key === undefined) {
    throw new Error("resuming a recoverable episode must open a repair operation");
  }
  return key;
}

afterEach(async () => {
  await reset();
});

test("rejects the failed generation as a verified repair candidate", async () => {
  const { control, episode } = await episodeWithFallback("recovery-rejects-failed-candidate");
  const startup = await openStartupCheck(control, episode, replacementCommit);
  const key = startupCheckKey(startup);
  await prepareGeneration(control, episode.failure.failedGenerationLabel, replacementCommit);

  expect(
    await control.reportRecoveryOperation(
      episode.id,
      key,
      { kind: "startup-check-passed", generationLabel: episode.failure.failedGenerationLabel },
      episode.startedAt + 2,
    ),
  ).toEqual({ applied: false, episode: startup });
});

test("rejects the retained fallback as a verified repair candidate", async () => {
  const { control, episode } = await episodeWithFallback("recovery-rejects-fallback-candidate");
  const fallbackGenerationLabel = episode.fallbackGenerationLabel;
  if (fallbackGenerationLabel === undefined) {
    throw new Error("this episode must retain a fallback generation");
  }
  const startup = await openStartupCheck(control, episode, fixtureMainHarnessCommit);
  const key = startupCheckKey(startup);
  await prepareGeneration(control, fallbackGenerationLabel, fixtureMainHarnessCommit);

  expect(
    await control.reportRecoveryOperation(
      episode.id,
      key,
      { kind: "startup-check-passed", generationLabel: fallbackGenerationLabel },
      episode.startedAt + 2,
    ),
  ).toEqual({ applied: false, episode: startup });
});

test("rejects a structured-clone object error without changing its persisted episode", async () => {
  const { control, episode } = await episodeWithFallback("recovery-rejects-object-error");
  const opened = await openRepair(control, episode);
  try {
    throw structuredClone(new Error("structured clone carries this object"));
  } catch (objectError) {
    const report = await control.reportRecoveryOperation(
      episode.id,
      repairKey(opened),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: JavaScript/RPC callers can violate TypeScript, and this assertion exists solely to exercise runtime parsing.
      { kind: "repair-failed", error: objectError as string },
      episode.startedAt + 1,
    );

    expect(report).toEqual({ applied: false, episode: opened });
    await evictDurableObject(control);
    expect(await control.getRecoveryEpisode(episode.id)).toEqual(opened);
  }
});

test("rejects a trailing lone surrogate operation error without URIError or persistence mutation", async () => {
  const { control, episode } = await episodeWithFallback("recovery-rejects-trailing-surrogate");
  const opened = await openRepair(control, episode);
  const report = await control.reportRecoveryOperation(
    episode.id,
    repairKey(opened),
    { kind: "repair-failed", error: "bad error \uD800" },
    episode.startedAt + 1,
  );

  expect(report).toEqual({ applied: false, episode: opened });
  await evictDurableObject(control);
  expect(await control.getRecoveryEpisode(episode.id)).toEqual(opened);
});

test("rejects pre-start resume, report, and reconciliation without changing the episode", async () => {
  const { control, episode } = await episodeWithFallback("recovery-before-start");
  const expected = { name: "RangeError", message: "recovery time cannot precede episode start" };
  await control.resumeRecovery(episode.id, episode.startedAt - 1).then(
    () => {
      throw new Error("a pre-start resume must reject");
    },
    (cause) => {
      expect(cause).toMatchObject(expected);
    },
  );
  expect(await control.getRecoveryEpisode(episode.id)).toEqual(episode);

  const opened = await openRepair(control, episode);
  await control
    .reportRecoveryOperation(
      episode.id,
      repairKey(opened),
      { kind: "repair-failed", error: "failed" },
      episode.startedAt - 1,
    )
    .then(
      () => {
        throw new Error("a pre-start report must reject");
      },
      (cause) => {
        expect(cause).toMatchObject(expected);
      },
    );
  await control
    .reconcileRecoveryOperation(
      episode.id,
      repairKey(opened),
      { kind: "repair-failed", error: "failed" },
      episode.startedAt - 1,
    )
    .then(
      () => {
        throw new Error("a pre-start reconciliation must reject");
      },
      (cause) => {
        expect(cause).toMatchObject(expected);
      },
    );
  expect(await control.getRecoveryEpisode(episode.id)).toEqual(opened);
});

test("rejects persisted operations whose attempt differs from attempts used", async () => {
  const { control, episode } = await episodeWithFallback("recovery-rejects-corrupt-operation");
  const first = await openRepair(control, episode);
  await control.reportRecoveryOperation(
    episode.id,
    repairKey(first),
    { kind: "repair-failed", error: "first" },
    episode.startedAt + 1,
  );
  await openRepair(control, episode);

  await runInDurableObject(control, (_instance, state) => {
    expect(() => {
      state.storage.sql.exec(
        "UPDATE recovery_episodes SET operation_attempt = 1 WHERE id = ?",
        episode.id,
      );
    }).toThrow();
    state.storage.sql.exec("PRAGMA ignore_check_constraints = ON");
    state.storage.sql.exec(
      "UPDATE recovery_episodes SET operation_attempt = 1 WHERE id = ?",
      episode.id,
    );
    state.storage.sql.exec("PRAGMA ignore_check_constraints = OFF");
  });
  await evictDurableObject(control);

  await control.getRecoveryEpisode(episode.id).then(
    () => {
      throw new Error("a corrupt operation row must reject");
    },
    (cause) => {
      expect(cause).toMatchObject({
        message: `invalid persisted recovery ${episode.id}: operation bounds`,
      });
    },
  );
});

test("rejects a reused failure event ID with a different failed generation", async () => {
  const { control } = await episodeWithFallback("recovery-rejects-conflicting-failure-replay");

  await control
    .startRecovery(
      { failureEventId: "failure-1", failedGenerationLabel: 0 },
      policy,
      2_000,
      strictEligibility,
    )
    .then(
      () => {
        throw new Error("a conflicting failure replay must reject");
      },
      (cause) => {
        expect(cause).toMatchObject({
          message: "failure event ID already belongs to generation 1",
        });
      },
    );
});
