import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../facet/fixture.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  artifact,
  prepareGeneration,
  storeModuleMap,
  submitCandidate,
  generationLabel,
  servingFacetSource,
  testHarnessCommit,
} from "../helpers.js";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { readGeneration, readGenerations } from "../generation-reads.js";

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";

const thirdHarnessCommit = "1123456789abcdef0123456789abcdef01234567";

function stagedPreparationArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    servingFacetSource(
      "staged",
      `constructor(ctx, env) {
    super(ctx, env);
    globalThis.checks = (globalThis.checks ?? 0) + 1;
  }
  compatibility() {
    return globalThis.checks < 7 ? ${JSON.stringify(FACET_COMPATIBILITY)} : "0.0.1";
  }`,
    ),
  );
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function submit(control: DurableObjectStub<Supervisor>, harnessCommit: string) {
  return control.submitGeneration(testHarnessCommit(harnessCommit));
}

afterEach(async () => {
  await reset();
});

test("submits the fixture harness commit as Generation 0 and the next commit as Generation 1", async () => {
  const control = supervisor("labels-generations");

  const first = await submit(control, fixtureMainHarnessCommit);
  const second = await submit(control, secondHarnessCommit);

  expect(first).toEqual({
    kind: "candidate-submitted",
    generation: { label: 0, harnessCommit: fixtureMainHarnessCommit, status: "candidate" },
    epoch: 1,
  });
  expect(second).toMatchObject({
    kind: "candidate-submitted",
    generation: { label: 1, harnessCommit: secondHarnessCommit, status: "candidate" },
    epoch: 2,
  });
  expect(await readGenerations(control)).toHaveLength(2);
});

test("a later preparation outcome replaces the recorded status", async () => {
  const control = supervisor("records-latest-preparation-outcome");
  const label = await submitCandidate(control, secondHarnessCommit);

  await storeModuleMap(control, stagedPreparationArtifact(secondHarnessCommit));
  const recorded = await control.prepareGeneration(generationLabel(label));
  const repeated = await control.prepareGeneration(generationLabel(label));
  const failed = await control.prepareGeneration(generationLabel(label));

  if (!recorded.ok || !repeated.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  expect(repeated).toEqual({
    ...recorded,
    report: { ...recorded.report, effect: "no-op" },
  });
  expect(failed).toMatchObject({
    ok: true,
    report: {
      stage: "compatibility-mismatch",
      effect: "recorded",
      generation: { label, status: "failed" },
    },
  });
  expect(await readGeneration(control, label)).toMatchObject({ status: "failed" });
});

test("preserves generation state across eviction and labels nothing itself", async () => {
  const control = supervisor("persists-across-eviction");
  const label = await submitCandidate(control, thirdHarnessCommit);
  await prepareGeneration(control, label, thirdHarnessCommit);

  await evictDurableObject(control);

  expect(await readGenerations(control)).toEqual([
    { label: 0, harnessCommit: thirdHarnessCommit, status: "ready" },
  ]);
  expect(await control.getActiveGeneration()).toEqual({
    generation: undefined,
    epoch: 2,
  });
});
