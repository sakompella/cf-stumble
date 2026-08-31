/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, artifact, prepareGeneration, submitCandidate } from "./helpers.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = supervisor(name);
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  await activateGeneration(control, 0, "activate-fixture");
  return control;
}

function servingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("candidate serving body"); }
}
`,
  );
}

function failingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("candidate failed", { status: 500 }); }
}
`,
  );
}

async function activateServingCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
  requestId: string,
): Promise<void> {
  const candidate = await submitCandidate(control, harnessCommit, `submit-${requestId}`);
  const startup = await control.checkGenerationStartup(candidate, servingArtifact(harnessCommit));
  if (!startup.ok || startup.report.stage !== "ready") {
    throw new Error("the candidate must pass startup before activation");
  }

  await activateGeneration(control, candidate, requestId);
}

afterEach(async () => {
  await reset();
});

test("serves the activated generation's retained artifact", async () => {
  const control = await activeSupervisor("serves-active-generation");
  await activateServingCandidate(
    control,
    "0123456789abcdef0123456789abcdef01234567",
    "activate-serving-candidate",
  );

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("serves the active retained artifact after Durable Object eviction", async () => {
  const control = await activeSupervisor("serves-active-generation-after-eviction");
  await activateServingCandidate(
    control,
    "d123456789abcdef0123456789abcdef01234567",
    "activate-serving-candidate-after-eviction",
  );
  await evictDurableObject(control);

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("keeps the active retained artifact when a failed candidate cannot activate", async () => {
  const control = await activeSupervisor("failed-candidate-keeps-active-artifact");
  await activateServingCandidate(
    control,
    "e123456789abcdef0123456789abcdef01234567",
    "activate-serving-candidate-before-failure",
  );
  const failedCandidate = await submitCandidate(
    control,
    "f123456789abcdef0123456789abcdef01234567",
    "submit-failed-serving-candidate",
  );
  const failedStartup = await control.checkGenerationStartup(
    failedCandidate,
    failingArtifact("f123456789abcdef0123456789abcdef01234567"),
  );
  if (!failedStartup.ok || failedStartup.report.stage !== "response-rejected") {
    throw new Error("the candidate must fail its startup check");
  }

  const active = await control.getActiveGeneration();
  const activation = await control.controlGeneration({
    requestId: "activate-failed-serving-candidate",
    principal: { kind: "user" },
    command: { kind: "activate", label: failedCandidate, observedEpoch: active.epoch },
  });
  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(activation).toEqual({ ok: false, problem: { code: "not-ready" } });
  expect(await response.text()).toBe("candidate serving body");
});
