import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  prepareGeneration,
  servedText,
  submitCandidate,
  generationLabel,
} from "./helpers.js";
import { readGeneration } from "./generation-reads.js";

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
  const generation = await readGeneration(control, 1);

  if (generation === undefined) {
    throw new Error("the replacement generation must be labeled");
  }

  return control.controlGeneration({ kind: "activate", label: generation.label, observedEpoch });
}

afterEach(async () => {
  await reset();
});

test("keeps the activation epoch stable while the active generation serves", async () => {
  const control = await readyReplacement("epoch-scope-serving");
  const beforeServing = await control.getActiveGeneration();

  await servedText(control);

  expect(await control.getActiveGeneration()).toEqual(beforeServing);
  const activated = await activateReplacement(control, beforeServing.epoch);
  expect(activated).toMatchObject({
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
  const rechecked = await control.prepareGeneration(generationLabel(0));

  const afterRecheck = await control.getActiveGeneration();

  const result = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(targetLabel),
    observedEpoch: beforeRecheck.epoch,
  });

  if (!rechecked.ok) {
    throw new Error("a repeated passing check must be accepted");
  }

  expect(rechecked.report.effect).toBe("no-op");
  expect(afterRecheck).toEqual({ ...beforeRecheck, epoch: beforeRecheck.epoch + 1 });
  expect(result).toEqual({ ok: false, problem: { code: "stale-epoch" } });
});
