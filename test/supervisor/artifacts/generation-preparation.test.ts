import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../facet/fixture.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/artifact.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activeSupervisor,
  labelCandidate,
  servedText,
  servingFacetSource,
  storeModuleMap,
  generationLabel,
} from "../helpers.js";
import { readGeneration } from "../generation-reads.js";

const commits = {
  stored: "4000000000000000000000000000000000000001",
  unstored: "4000000000000000000000000000000000000002",
} as const;

function storedModuleMap(harnessCommit: string): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      {
        name: "main.js",
        source: servingFacetSource("stored candidate serving"),
      },
    ],
  };
}

async function activate(control: DurableObjectStub<Supervisor>, label: number): Promise<void> {
  const active = await control.getActiveGeneration();

  const activation = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(label),
    observedEpoch: active.epoch,
  });

  if (!activation.ok) {
    throw new Error(`a prepared generation must activate: ${activation.problem.code}`);
  }
}

afterEach(async () => {
  await reset();
});

test("prepares and serves a generation from its stored module map", async () => {
  const control = await activeSupervisor("prepare-from-stored-module-map");
  await storeModuleMap(storedModuleMap(commits.stored));
  const label = await labelCandidate(control, commits.stored);

  const prepared = await control.prepareGeneration(generationLabel(label));

  expect(prepared).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(await readGeneration(control, label)).toMatchObject({ label, status: "ready" });

  await activate(control, label);

  expect(await servedText(control)).toBe("stored candidate serving");
});

test("leaves the active generation serving when the module map cannot be built", async () => {
  const control = await activeSupervisor("failed-build-keeps-active-generation");
  const label = await labelCandidate(control, commits.unstored);

  const prepared = await control.prepareGeneration(generationLabel(label));

  expect(prepared).toEqual({
    ok: false,
    problem: { code: "build-workspace-unavailable", harnessCommit: commits.unstored },
  });
  expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype);
  expect(
    await readGeneration(control, label),
    "an unbuildable commit is no evidence about the candidate",
  ).toMatchObject({ label, status: "candidate" });

  const active = await control.getActiveGeneration();

  expect(active.generation).toMatchObject({ label: 0, harnessCommit: fixtureMainHarnessCommit });
  expect(await servedText(control)).toBe(fixtureMainHarnessCommit);
});
