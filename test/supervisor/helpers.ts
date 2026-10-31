import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { ConnectedProjects } from "../../src/supervisor/projects/index.js";
import { sampleCatalog } from "../project-fixtures.js";
import {
  fixtureMainHarnessArtifact,
  fixtureMainHarnessCommit,
  parsedArtifact,
  servingFacetSource,
} from "../facet/fixture.js";
import type { MainHarnessArtifactInput } from "../../src/facet/index.js";
import { ModuleMapStore } from "../../src/supervisor/artifacts/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { label as generationLabel, testHarnessCommit } from "./generations/fixtures.js";

export const commits = {
  ordinary: "0123456789abcdef0123456789abcdef01234567",
  noVersion: "1123456789abcdef0123456789abcdef01234567",
  parse: "2123456789abcdef0123456789abcdef01234567",
  missingFacet: "3123456789abcdef0123456789abcdef01234567",
  constructor: "4123456789abcdef0123456789abcdef01234567",
  request: "5123456789abcdef0123456789abcdef01234567",
  delayed: "7123456789abcdef0123456789abcdef01234567",
  fresh: "b123456789abcdef0123456789abcdef01234567",
} as const;

export { generationLabel, testHarnessCommit };

export {
  fixtureMainHarnessCommit,
  parsedArtifact,
  FACET_COMPATIBILITY_METHOD,
  servingFacetSource,
} from "../facet/fixture.js";

export function artifact(harnessCommit: string, source: string): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [{ name: "main.js", source }],
  };
}

export function readyArtifact(harnessCommit: string): MainHarnessArtifactInput {
  if (harnessCommit === fixtureMainHarnessCommit) {
    return fixtureMainHarnessArtifact;
  }

  return artifact(harnessCommit, servingFacetSource(harnessCommit));
}

export async function servedText(control: DurableObjectStub<Supervisor>): Promise<string> {
  const result = await control.projectEvents("harness");

  if (!result.ok) return `refused: ${result.problem.code}`;

  return new Response(result.events).text();
}

export function storeModuleMap(
  control: DurableObjectStub<Supervisor>,
  input: MainHarnessArtifactInput,
): Promise<void> {
  return runInDurableObject(control, (_instance, state) => {
    const written = new ModuleMapStore(state.storage).write(parsedArtifact(input));

    if (written._tag === "Failure") {
      throw new Error(`a stored module map must be written: ${written.failure.code}`);
    }
  });
}

export function connectSampleProjects(control: DurableObjectStub<Supervisor>): Promise<void> {
  return runInDurableObject(control, (_instance, state) => {
    const projects = new ConnectedProjects(state.storage);

    for (const project of sampleCatalog) {
      projects.connect(
        { repositoryUrl: project.repositoryUrl, displayName: project.displayName },
        0,
      );
    }
  });
}

export async function connectedSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await connectSampleProjects(control);

  return control;
}

export async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await activateFixtureGeneration(control);

  return control;
}

export async function prepareFixtureGeneration(
  control: DurableObjectStub<Supervisor>,
): Promise<number> {
  const label = await submitCandidate(control, fixtureMainHarnessCommit);
  expect(label, "the first submitted commit must take generation label 0").toBe(0);
  await prepareGeneration(control, label, fixtureMainHarnessCommit);

  return label;
}

export async function activateFixtureGeneration(
  control: DurableObjectStub<Supervisor>,
): Promise<number> {
  const label = await prepareFixtureGeneration(control);

  return activateGeneration(control, label);
}

export async function submitCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  const submission = await control.submitGeneration(testHarnessCommit(harnessCommit));

  return submission.generation.label;
}

export function labelCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  return submitCandidate(control, harnessCommit);
}

export async function prepareWithModuleMap(
  control: DurableObjectStub<Supervisor>,
  label: number,
  moduleMap: MainHarnessArtifactInput,
  options?: Parameters<Supervisor["prepareGeneration"]>[1],
) {
  await storeModuleMap(control, moduleMap);

  return control.prepareGeneration(generationLabel(label), options);
}

export async function prepareGeneration(
  control: DurableObjectStub<Supervisor>,
  label: number,
  harnessCommit: string,
): Promise<void> {
  const result = await prepareWithModuleMap(control, label, readyArtifact(harnessCommit));

  if (!result.ok || result.report.stage !== "ready") {
    throw new Error("a valid generation must pass startup checking");
  }
}

export async function activateGeneration(
  control: DurableObjectStub<Supervisor>,
  label: number,
): Promise<number> {
  const active = await control.getActiveGeneration();

  const result = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(label),
    observedEpoch: active.epoch,
  });

  if (!result.ok || result.outcome.kind !== "activated") {
    throw new Error("a ready generation must become active");
  }

  return result.outcome.epoch;
}
