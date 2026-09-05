/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { ConnectedProjects } from "../../src/supervisor/projects/index.js";
import { sampleCatalog } from "../project-fixtures.js";
import { fixtureMainHarnessArtifact, fixtureMainHarnessCommit } from "../../src/facet/fixture.js";
import type { MainHarnessArtifactInput } from "../../src/facet/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

export const commits = {
  ordinary: "0123456789abcdef0123456789abcdef01234567",
  notFound: "1123456789abcdef0123456789abcdef01234567",
  parse: "2123456789abcdef0123456789abcdef01234567",
  missingFacet: "3123456789abcdef0123456789abcdef01234567",
  constructor: "4123456789abcdef0123456789abcdef01234567",
  request: "5123456789abcdef0123456789abcdef01234567",
  errorResponse: "6123456789abcdef0123456789abcdef01234567",
  delayed: "7123456789abcdef0123456789abcdef01234567",
  oversized: "8123456789abcdef0123456789abcdef01234567",
  mismatch: "9123456789abcdef0123456789abcdef01234567",
  malformed: "a123456789abcdef0123456789abcdef01234567",
  fresh: "b123456789abcdef0123456789abcdef01234567",
} as const;

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

  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("ready"); }
}
`,
  );
}

/**
 * Give a Supervisor the two projects of `test/project-fixtures.ts`.
 *
 * A real connection verifies repository access and clones through the Workspace Host, and this
 * runtime has no container to do either, so these tests write the rows a connection writes and
 * nothing else. The Supervisor then resolves project ids exactly as it does in a deployment: from
 * its own `connected_projects` table.
 */
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

export async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await activateFixtureGeneration(control);
  return control;
}

/**
 * Bring a Supervisor to a prepared Generation 0 built from the fixture module map.
 *
 * The Supervisor no longer seeds a generation, so Generation 0 is an ordinary owner submission
 * here exactly as it is in the deploy procedure: the fixture commit is submitted, takes label 0
 * because it is the first submission, and is then prepared. The check on the label keeps the
 * tests that name generation 0 honest about why it is 0.
 */
export async function prepareFixtureGeneration(
  control: DurableObjectStub<Supervisor>,
): Promise<number> {
  const label = await submitCandidate(control, fixtureMainHarnessCommit);
  expect(label, "the first submitted commit must take generation label 0").toBe(0);
  await prepareGeneration(control, label, fixtureMainHarnessCommit);
  return label;
}

/**
 * Submit, prepare, and activate the fixture commit as Generation 0. Returns the epoch the
 * activation recorded, like `activateGeneration`, because that is the epoch a following control
 * request must observe.
 */
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
  const result = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "submit-candidate", harnessCommit },
  });
  if (!result.ok || result.outcome.kind !== "candidate-submitted") {
    throw new Error("a valid harness commit must receive a generation label");
  }

  return result.outcome.generation.label;
}

export function labelCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  return submitCandidate(control, harnessCommit);
}

export async function prepareGeneration(
  control: DurableObjectStub<Supervisor>,
  label: number,
  harnessCommit: string,
): Promise<void> {
  const result = await control.checkGenerationStartup(label, readyArtifact(harnessCommit));
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
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: active.epoch },
  });
  if (!result.ok || result.outcome.kind !== "activated") {
    throw new Error("a ready generation must become active");
  }

  return result.outcome.epoch;
}

export async function expectFailedCandidate(
  control: DurableObjectStub<Supervisor>,
  label: number,
): Promise<void> {
  const generation = await control.getGeneration(label);
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
