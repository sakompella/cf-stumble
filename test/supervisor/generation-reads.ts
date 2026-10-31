import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { fixtureMainHarnessCommit } from "../facet/fixture.js";
import {
  Generations,
  parseGenerationLabel,
  type Generation,
} from "../../src/supervisor/generations/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

export function readGeneration(
  control: DurableObjectStub<Supervisor>,
  label: number,
): Promise<Generation | undefined> {
  return runInDurableObject(control, (_instance, state) => {
    const generationLabel = parseGenerationLabel(label);

    return generationLabel === undefined
      ? undefined
      : new Generations(state.storage).byLabel(generationLabel);
  });
}

export function readGenerations(control: DurableObjectStub<Supervisor>): Promise<Generation[]> {
  return runInDurableObject(control, (_instance, state) => [
    ...new Generations(state.storage).all(),
  ]);
}

export async function expectFailedCandidate(
  control: DurableObjectStub<Supervisor>,
  label: number,
): Promise<void> {
  const generation = await readGeneration(control, label);
  expect(generation, "a failed candidate must retain its labeled generation").toMatchObject({
    label,
    status: "failed",
  });
  const active = await control.getActiveGeneration();
  expect(active.generation, "a candidate check must not replace active traffic").toEqual({
    label: 0,
    harnessCommit: fixtureMainHarnessCommit,
    status: "ready",
  });
  expect(active.epoch).toBeTypeOf("number");
}
