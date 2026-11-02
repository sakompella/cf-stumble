import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  prepareGeneration,
  servedText,
  submitCandidate,
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
