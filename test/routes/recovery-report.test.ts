/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { RecoveryReportSummary } from "../../src/routes/index.js";
import type { EligibilityPolicy } from "../../src/supervisor/eligibility.js";
import type { RecoveryPolicy } from "../../src/supervisor/recovery/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activeSupervisor } from "../supervisor/helpers.js";
import { ownerScope } from "./helpers.js";

const policy: RecoveryPolicy = {
  maxRepairAttempts: 2,
  recoveryBudgetMs: 100,
  operationDeadlineMs: 10,
};
const strictEligibility: EligibilityPolicy = {
  minimumCreditedTurns: 1,
  minimumObservationSpanMs: 0,
};

type RecoveryResponse = {
  readonly ok: true;
  readonly report: RecoveryReportSummary | null;
};

type StatusResponse = {
  readonly activeGeneration: { readonly epoch: number };
  readonly latestRecoveryReport: RecoveryReportSummary | null;
};

function latestRecovery(stub: DurableObjectStub<Supervisor>): Promise<Response> {
  return routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/recovery/latest"),
    stub,
    ownerScope,
  );
}

function status(stub: DurableObjectStub<Supervisor>): Promise<Response> {
  return routeOwnerApiRequest(new Request("https://cf-stumble.test/api/status"), stub, ownerScope);
}

afterEach(async () => {
  await reset();
});

test("reports the recorded recovery episode and claims no repair of its own", async () => {
  const stub = await activeSupervisor("routes-recovery-latest");
  const episode = await stub.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );

  const response = await latestRecovery(stub);

  expect(response.status).toBe(200);
  const body = await response.json<RecoveryResponse>();
  expect(body).toEqual({
    ok: true,
    report: {
      id: episode.id,
      failureEventId: "failure-0",
      failedGenerationLabel: 0,
      fallbackGenerationLabel: null,
      phase: "blocked",
      result: "blocked:no-known-good-generation",
      attemptsUsed: 0,
      startedAt: 1_000,
      errorCount: 0,
      awaitingExternalReport: null,
    },
  });
});

test("keeps the recovery summary to recorded facts without error text", async () => {
  const stub = await activeSupervisor("routes-recovery-fields");
  await stub.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );

  const body = await (await latestRecovery(stub)).json<RecoveryResponse>();

  expect(body.report === null ? [] : Object.keys(body.report).toSorted()).toEqual([
    "attemptsUsed",
    "awaitingExternalReport",
    "errorCount",
    "failedGenerationLabel",
    "failureEventId",
    "fallbackGenerationLabel",
    "id",
    "phase",
    "result",
    "startedAt",
  ]);
});

test("reports the most recent episode and reads without starting or resuming one", async () => {
  const stub = await activeSupervisor("routes-recovery-most-recent");
  await stub.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );
  const second = await stub.startRecovery(
    { failureEventId: "failure-1", failedGenerationLabel: 0 },
    policy,
    2_000,
    strictEligibility,
  );

  const first = await (await latestRecovery(stub)).json<RecoveryResponse>();
  const repeated = await (await latestRecovery(stub)).json<RecoveryResponse>();

  expect(first.report?.id).toBe(second.id);
  expect(first.report?.startedAt).toBe(2_000);
  expect(repeated).toEqual(first);
  expect(await stub.getRecoveryEpisode(second.id)).toEqual(second);
});

test("carries the active generation, the epoch, and the latest recovery report in status", async () => {
  const stub = await activeSupervisor("routes-status-recovery");
  const before = await (await status(stub)).json<StatusResponse>();
  await stub.startRecovery(
    { failureEventId: "failure-0", failedGenerationLabel: 0 },
    policy,
    1_000,
    strictEligibility,
  );

  const after = await (await status(stub)).json<StatusResponse>();

  expect(before.latestRecoveryReport).toBeNull();
  expect(after.latestRecoveryReport?.failureEventId).toBe("failure-0");
  expect(after.activeGeneration).toEqual(await stub.getActiveGeneration());
  expect(
    after.activeGeneration.epoch,
    "a recovery record is outside generation-control state",
  ).toBe(before.activeGeneration.epoch);
});
