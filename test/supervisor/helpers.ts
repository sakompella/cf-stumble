import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { seedSampleProjects } from "./projects/seed-connected.js";
import {
  fixtureMainHarnessArtifact,
  fixtureMainHarnessCommit,
  parsedArtifact,
  servingFacetSource,
} from "../facet/fixture.js";
import type { MainHarnessArtifactInput } from "../../src/facet/artifact.js";
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
  failingMessages: "c123456789abcdef0123456789abcdef01234567",
  noGenerationControl: "d123456789abcdef0123456789abcdef01234567",
  unsettled: "e123456789abcdef0123456789abcdef01234567",
  failingAttach: "f123456789abcdef0123456789abcdef01234567",
  failingResume: "8123456789abcdef0123456789abcdef01234567",
  secretFailure: "a23456789abcdef0123456789abcdef012345679",
  secretReply: "6123456789abcdef0123456789abcdef01234567",
} as const;

export { generationLabel, testHarnessCommit };

export {
  fixtureMainHarnessCommit,
  parsedArtifact,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
  STARTUP_CHECK_CONVERSATION,
  servingFacetSource,
} from "../facet/fixture.js";

export function artifact(harnessCommit: string, source: string): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [{ name: "main.js", source }],
  };
}

export function facet(members: string): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${members}
}
`;
}

export async function checked(name: string, harnessCommit: string, source: string) {
  const control = await activeSupervisor(name);
  const label = await labelCandidate(control, harnessCommit);

  const result = await prepareWithModuleMap(control, label, artifact(harnessCommit, source));

  return { control, label, result };
}

export function largeModuleMap(harnessCommit: string): MainHarnessArtifactInput {
  const filler = "\u2603".repeat(200_000);

  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      { name: "main.js", source: `export const snowman = "${filler}";\n` },
      { name: "helper.js", source: `export const helper = "${filler}";\n` },
    ],
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

export async function storeModuleMap(input: MainHarnessArtifactInput): Promise<void> {
  const written = await new ModuleMapStore(env.MODULE_MAPS).write(parsedArtifact(input));

  if (written._tag === "Failure") {
    throw new Error(`a stored module map must be written: ${written.failure.code}`);
  }
}

export function connectSampleProjects(control: DurableObjectStub<Supervisor>): Promise<void> {
  return runInDurableObject(control, (_instance, state) => {
    seedSampleProjects(state.storage);
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
) {
  await storeModuleMap(moduleMap);

  return control.prepareGeneration(generationLabel(label));
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
