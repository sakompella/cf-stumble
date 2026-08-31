/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { RelayAttempts } from "../../src/supervisor/relay-attempts.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  activeSupervisor,
  prepareGeneration,
  submitCandidate,
} from "./helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";

async function recordCancelledAttempt(
  control: DurableObjectStub<Supervisor>,
  responseStatus?: number,
): Promise<void> {
  await runInDurableObject(control, (instance, state) => {
    const active = instance.getActiveGeneration();
    const preparationCheck = instance.getPreparationCheckHistory(0).at(-1);
    if (active.generation === undefined || preparationCheck === undefined) {
      throw new Error("an active generation needs a preparation check");
    }

    const attempts = new RelayAttempts(state.storage);
    const attempt = attempts.start(active, preparationCheck.id, 1_000, 100);
    if (responseStatus !== undefined) {
      attempts.headersReceived(attempt.id, responseStatus);
    }
    attempts.settle(attempt.id, "relay-cancelled", 1_002);
  });
}

afterEach(async () => {
  await reset();
});

test("keeps cancellations from either side of headers neutral after an eviction", async () => {
  const control = await activeSupervisor("relay-cancellation-lifecycle");
  const response = await control.fetch(
    new Request("https://cf-stumble.test/facet/relay/body-complete"),
  );
  await response.text();
  await recordCancelledAttempt(control);
  await recordCancelledAttempt(control, 200);
  await evictDurableObject(control);

  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "body-completed", responseStatus: 200 },
    { outcome: "relay-cancelled", responseStatus: undefined },
    { outcome: "relay-cancelled", responseStatus: 200 },
  ]);
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "eligible", creditedTurns: 1 });

  const replacementLabel = await submitCandidate(control, replacementCommit, "submit-replacement");
  await prepareGeneration(control, replacementLabel, replacementCommit);
  await activateGeneration(control, replacementLabel, "activate-replacement");

  expect(
    await control.startRecovery(
      { failureEventId: "failed-replacement", failedGenerationLabel: replacementLabel },
      { maxRepairAttempts: 1, recoveryBudgetMs: 100, operationDeadlineMs: 10 },
      2_000,
      { minimumCreditedTurns: 1, minimumObservationSpanMs: 0 },
    ),
  ).toMatchObject({ fallbackGenerationLabel: 0, phase: "ready" });
});
