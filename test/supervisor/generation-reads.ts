import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { fixtureMainHarnessCommit } from "../facet/fixture.js";
import { Generations, type Generation } from "../../src/supervisor/generations.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { label as generationLabel } from "./generations/fixtures.js";

export function readGeneration(
  control: DurableObjectStub<Supervisor>,
  labelValue: number,
): Promise<Generation | undefined> {
  return runInDurableObject(control, (_instance, state) =>
    new Generations(state.storage).byLabel(generationLabel(labelValue)),
  );
}

export function readGenerations(
  control: DurableObjectStub<Supervisor>,
): Promise<{ label: number; harnessCommit: string; status: string }[]> {
  return runInDurableObject(control, (_instance, state) =>
    state.storage.sql
      .exec<{ label: number; harness_commit: string; status: string }>(
        "SELECT label, harness_commit, status FROM generations ORDER BY label",
      )
      .toArray()
      .map((row) => ({ label: row.label, harnessCommit: row.harness_commit, status: row.status })),
  );
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
