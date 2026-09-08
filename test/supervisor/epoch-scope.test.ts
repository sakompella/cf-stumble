/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/fixture.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  prepareGeneration,
  readyArtifact,
  submitCandidate,
} from "./helpers.js";

const replacementCommit = "0123456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

async function readyReplacement(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = supervisor(name);
  await activateFixtureGeneration(control);
  const label = await submitCandidate(control, replacementCommit);
  await prepareGeneration(control, label, replacementCommit);
  return control;
}

async function activateReplacement(control: DurableObjectStub<Supervisor>, observedEpoch: number) {
  const generation = await control.getGeneration(1);
  if (generation === undefined) {
    throw new Error("the replacement generation must be labeled");
  }

  return control.controlGeneration({
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

afterEach(async () => {
  await reset();
});

test("keeps the activation epoch stable while relaying a completed turn", async () => {
  const control = await readyReplacement("epoch-scope-relay");
  const beforeRelay = await control.getActiveGeneration();

  await completedTurn(control);

  expect(await control.getActiveGeneration()).toEqual(beforeRelay);
  const activated = await activateReplacement(control, beforeRelay.epoch);
  expect(activated).toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label: 1 } },
  });
});

test("keeps the activation epoch stable when an activation is rejected", async () => {
  const control = await readyReplacement("epoch-scope-rejected-request");
  const beforeRejection = await control.getActiveGeneration();

  const rejected = await control.controlGeneration({
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

test("a repeated passing check advances the epoch and rejects an activation from its prior view", async () => {
  const control: DurableObjectStub<Supervisor> = env.SUPERVISOR.getByName(
    "epoch-scope-recheck-stale-activation",
  );
  await activateFixtureGeneration(control);
  const targetLabel = await submitCandidate(control, replacementCommit);
  await prepareGeneration(control, targetLabel, replacementCommit);

  const beforeRecheck = await control.getActiveGeneration();
  const checksBefore = await control.getPreparationCheckHistory(0);
  const rechecked = await control.checkGenerationStartup(
    0,
    readyArtifact(fixtureMainHarnessCommit),
  );
  const checksAfter = await control.getPreparationCheckHistory(0);
  const afterRecheck = await control.getActiveGeneration();
  const result = await control.controlGeneration({
    principal: { kind: "user" },
    command: {
      kind: "activate",
      label: targetLabel,
      observedEpoch: beforeRecheck.epoch,
    },
  });

  if (!rechecked.ok) {
    throw new Error("a repeated passing check must be accepted");
  }

  expect(rechecked.report.effect).toBe("no-op");
  expect(checksAfter).toHaveLength(checksBefore.length + 1);
  expect(checksAfter.at(-1)?.id).not.toBe(checksBefore.at(-1)?.id);
  expect(afterRecheck).toEqual({ ...beforeRecheck, epoch: beforeRecheck.epoch + 1 });
  expect(result).toEqual({ ok: false, problem: { code: "stale-epoch" } });
});
