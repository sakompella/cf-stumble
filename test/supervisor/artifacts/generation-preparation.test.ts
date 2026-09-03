/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { activeSupervisor, labelCandidate } from "../helpers.js";

const commits = {
  cached: "4000000000000000000000000000000000000001",
  uncached: "4000000000000000000000000000000000000002",
} as const;

function cachedModuleMap(harnessCommit: string): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      {
        name: "main.js",
        source: `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("cached candidate serving"); }
}
`,
      },
    ],
  };
}

async function seedCache(harnessCommit: string): Promise<void> {
  await env.MODULE_MAPS.put(
    `module-maps/${harnessCommit}`,
    encodeModuleMap(cachedModuleMap(harnessCommit)),
  );
}

async function activate(
  control: DurableObjectStub<Supervisor>,
  label: number,
  requestId: string,
): Promise<void> {
  const active = await control.getActiveGeneration();
  const activation = await control.controlGeneration({
    requestId,
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: active.epoch },
  });
  if (!activation.ok) {
    throw new Error(`a prepared generation must activate: ${activation.problem.code}`);
  }
}

afterEach(async () => {
  await reset();
});

test("prepares and serves a generation from its cached module map", async () => {
  const control = await activeSupervisor("prepare-from-cached-module-map");
  await seedCache(commits.cached);
  const label = await labelCandidate(control, commits.cached);

  const prepared = await control.prepareGeneration(label);

  expect(prepared).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(await control.getGeneration(label)).toMatchObject({ label, status: "ready" });

  await activate(control, label, "activate-cached-candidate");
  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("cached candidate serving");
});

/**
 * The Supervisor now holds a real build workspace builder, and a Workspace Host cannot start its
 * container in the test pool, so this exercises the wired build path and its failure. workerd logs
 * that container failure as an uncaught exception; the failure still arrives as a plain typed
 * problem, which is what the test asserts.
 */
test("leaves the active generation serving when the module map cannot be built", async () => {
  const control = await activeSupervisor("failed-build-keeps-active-generation");
  const label = await labelCandidate(control, commits.uncached);

  const prepared = await control.prepareGeneration(label);

  expect(prepared).toEqual({
    ok: false,
    problem: { code: "build-workspace-unavailable", harnessCommit: commits.uncached },
  });
  expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype);
  expect(
    await control.getGeneration(label),
    "an unbuildable commit is no evidence about the candidate",
  ).toMatchObject({ label, status: "candidate" });
  expect(await control.getPreparationCheckHistory(label)).toEqual([]);

  const active = await control.getActiveGeneration();
  const response = await control.fetch(new Request("https://cf-stumble.test/facet/ping"));

  expect(active.generation).toMatchObject({ label: 0, harnessCommit: fixtureMainHarnessCommit });
  expect(await response.text()).toBe("pong");
});
