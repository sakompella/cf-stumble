import { FACET_COMPATIBILITY } from "../../src/facet/runtime-contract.js";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { fixtureMainHarnessCommit } from "../facet/fixture.js";
import { Generations } from "../../src/supervisor/generations.js";
import type { Generation } from "../../src/supervisor/generation-state.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { label as generationLabel } from "./generations/fixtures.js";

export function readGeneration(
  control: DurableObjectStub<Supervisor>,
  labelValue: number,
): Promise<Generation | undefined> {
  return runInDurableObject(control, (_instance, state) =>
    new Generations(state.storage, FACET_COMPATIBILITY).byLabel(generationLabel(labelValue)),
  );
}

export function readGenerations(
  control: DurableObjectStub<Supervisor>,
): Promise<{ label: number; harnessCommit: string; status: string }[]> {
  return runInDurableObject(control, (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY);
    const read: { label: number; harnessCommit: string; status: string }[] = [];

    for (
      let generation = generations.byLabel(generationLabel(0));
      generation !== undefined;
      generation = generations.byLabel(generationLabel(read.length))
    ) {
      read.push({ ...generation });
    }

    return read;
  });
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
}
