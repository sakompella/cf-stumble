/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { fixtureMainHarnessArtifact, fixtureMainHarnessCommit } from "../../src/facet/index.js";
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

export async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  return control;
}

export async function submitCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
  requestId: string,
): Promise<number> {
  const result = await control.controlGeneration({
    requestId,
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
  return submitCandidate(control, harnessCommit, `submit-${harnessCommit}`);
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
  requestId: string,
): Promise<number> {
  const active = await control.getActiveGeneration();
  const result = await control.controlGeneration({
    requestId,
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
