/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, activeSupervisor, artifact, submitCandidate } from "./helpers.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
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
): Promise<void> {
  const candidate = await submitCandidate(control, harnessCommit);
  const startup = await control.checkGenerationStartup(candidate, servingArtifact(harnessCommit));
  if (!startup.ok || startup.report.stage !== "ready") {
    throw new Error("the candidate must pass startup before activation");
  }

  await activateGeneration(control, candidate);
}

afterEach(async () => {
  await reset();
});

/**
 * The Supervisor once seeded Generation 0 from the fixture commit and served the fixture module
 * map whenever no generation was active, so `/facet/ping` answered `pong` on a Supervisor that had
 * never been given code. Nothing is built in now: with no active generation there is nothing to
 * serve and nothing to attribute a relay attempt to.
 */
test("reports a typed failure and serves nothing when no generation is active", async () => {
  const control = supervisor("no-active-generation-serves-nothing");

  const response = await control.fetch(new Request("https://cf-stumble.test/facet/ping"));

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "no-active-generation" },
  });
  expect(await control.getGenerations(), "no submission means no labeled generation").toEqual([]);
  expect(
    await control.getRelayAttempts(),
    "a request that reached no generation is evidence about none",
  ).toEqual([]);
});

test("serves the activated generation's retained artifact", async () => {
  const control = await activeSupervisor("serves-active-generation");
  await activateServingCandidate(control, "0123456789abcdef0123456789abcdef01234567");

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("serves the active retained artifact after Durable Object eviction", async () => {
  const control = await activeSupervisor("serves-active-generation-after-eviction");
  await activateServingCandidate(control, "d123456789abcdef0123456789abcdef01234567");
  await evictDurableObject(control);

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("keeps the active retained artifact when a failed candidate cannot activate", async () => {
  const control = await activeSupervisor("failed-candidate-keeps-active-artifact");
  await activateServingCandidate(control, "e123456789abcdef0123456789abcdef01234567");
  const failedCandidate = await submitCandidate(
    control,
    "f123456789abcdef0123456789abcdef01234567",
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
    principal: { kind: "user" },
    command: { kind: "activate", label: failedCandidate, observedEpoch: active.epoch },
  });
  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(activation).toEqual({ ok: false, problem: { code: "not-ready" } });
  expect(await response.text()).toBe("candidate serving body");
});
