/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { MainHarnessArtifactInput } from "../../src/agent/loader.js";
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

export async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = env.SUPERVISOR.getByName(name);
  const prepared = await control.recordPreparationCheck(0, "passed");
  if (!prepared.ok) {
    throw new Error("Generation 0 must accept its preparation check");
  }

  const activated = await control.activateGeneration(0);
  if (!activated.ok) {
    throw new Error("Generation 0 must become active");
  }

  return control;
}

export async function labelCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  const labeled = await control.labelGeneration(harnessCommit);
  if (!labeled.ok) {
    throw new Error("a valid harness commit must receive a generation label");
  }

  return labeled.generation.label;
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
