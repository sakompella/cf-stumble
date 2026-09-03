/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/fixture.js";
import type { MainHarnessArtifactInput } from "../../src/facet/index.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { GenerationSubmissionResult } from "../../src/routes/index.js";
import { encodeModuleMap } from "../../src/supervisor/artifacts/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activeSupervisor } from "../supervisor/helpers.js";

const commits = {
  passing: "5100000000000000000000000000000000000001",
  unbuildable: "5100000000000000000000000000000000000002",
  rejecting: "5100000000000000000000000000000000000003",
  replayed: "5100000000000000000000000000000000000004",
  reusedId: "5100000000000000000000000000000000000005",
  replayedUnbuildable: "5100000000000000000000000000000000000006",
} as const;

function moduleMap(harnessCommit: string, body: string, status: number): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      {
        name: "main.js",
        source: `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response(${JSON.stringify(body)}, { status: ${String(status)} }); }
}
`,
      },
    ],
  };
}

/** A cached module map stands in for the build P4b wires, so no test needs a build workspace. */
async function seedCache(
  harnessCommit: string,
  body = "candidate serving",
  status = 200,
): Promise<void> {
  await env.MODULE_MAPS.put(
    `module-maps/${harnessCommit}`,
    encodeModuleMap(moduleMap(harnessCommit, body, status)),
  );
}

function submit(
  control: DurableObjectStub<Supervisor>,
  requestId: string,
  harnessCommit: string,
): Promise<Response> {
  return routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/generations/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, harnessCommit }),
    }),
    control,
  );
}

async function submission(
  control: DurableObjectStub<Supervisor>,
  requestId: string,
  harnessCommit: string,
): Promise<GenerationSubmissionResult> {
  const response = await submit(control, requestId, harnessCommit);
  expect(response.status).toBe(200);
  return response.json<GenerationSubmissionResult>();
}

function submittedLabel(result: GenerationSubmissionResult): number {
  if (!result.ok) {
    throw new Error(`a valid harness commit must receive a label: ${result.problem.code}`);
  }
  return result.outcome.generation.label;
}

/** Generation 0 keeps serving its fixture facet, which answers `/facet/ping` with `pong`. */
async function expectActiveFixtureStillServing(
  control: DurableObjectStub<Supervisor>,
): Promise<void> {
  const active = await control.getActiveGeneration();
  expect(active.generation, "a candidate check must not replace active traffic").toMatchObject({
    label: 0,
    harnessCommit: fixtureMainHarnessCommit,
    status: "ready",
  });
  const response = await control.fetch(new Request("https://cf-stumble.test/facet/ping"));
  expect(await response.text()).toBe("pong");
}

afterEach(async () => {
  await reset();
});

test("submits a passing candidate and leaves the active generation serving", async () => {
  const control = await activeSupervisor("submit-passing-candidate");
  await seedCache(commits.passing);

  const result = await submission(control, "submit-passing", commits.passing);

  expect(result).toMatchObject({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: { harnessCommit: commits.passing, status: "candidate" },
    },
    preparation: { ok: true, report: { stage: "ready", effect: "recorded" } },
  });
  expect(await control.getGeneration(submittedLabel(result))).toMatchObject({
    harnessCommit: commits.passing,
    status: "ready",
  });
  await expectActiveFixtureStillServing(control);
});

test("returns a recorded failing preparation when the candidate module map cannot be built", async () => {
  const control = await activeSupervisor("submit-unbuildable-candidate");

  const result = await submission(control, "submit-unbuildable", commits.unbuildable);

  expect(result).toMatchObject({
    ok: true,
    preparation: {
      ok: false,
      problem: { code: "build-workspace-unavailable", harnessCommit: commits.unbuildable },
    },
  });
  expect(
    await control.getGeneration(submittedLabel(result)),
    "an unbuildable commit is no evidence about the candidate",
  ).toMatchObject({ harnessCommit: commits.unbuildable, status: "candidate" });
  await expectActiveFixtureStillServing(control);
});

test("records a candidate that fails its startup check and keeps the active generation", async () => {
  const control = await activeSupervisor("submit-failing-candidate");
  await seedCache(commits.rejecting, "candidate refused the startup request", 500);

  const result = await submission(control, "submit-failing", commits.rejecting);
  const label = submittedLabel(result);

  expect(result).toMatchObject({
    ok: true,
    preparation: { ok: true, report: { stage: "response-rejected", status: 500 } },
  });
  expect(await control.getGeneration(label)).toMatchObject({ label, status: "failed" });
  expect(await control.getPreparationCheckHistory(label)).toMatchObject([{ outcome: "failed" }]);
  await expectActiveFixtureStillServing(control);
});

test("replaying one submission request ID returns the journaled labeling", async () => {
  const control = await activeSupervisor("submit-replay");
  await seedCache(commits.replayed);

  const first = await submission(control, "submit-replay", commits.replayed);
  const replay = await submission(control, "submit-replay", commits.replayed);

  expect(replay).toMatchObject({ ok: true, outcome: first.ok ? first.outcome : {} });
  expect(
    (await control.getGenerations()).filter(
      (generation) => generation.harnessCommit === commits.replayed,
    ),
    "a replayed request ID must not label the commit twice",
  ).toHaveLength(1);
  expect(replay).toMatchObject({ preparation: { ok: true, report: { stage: "ready" } } });
  await expectActiveFixtureStillServing(control);
});

test("replaying an unbuildable submission returns an identical result", async () => {
  const control = await activeSupervisor("submit-replay-unbuildable");
  const commit = commits.replayedUnbuildable;

  const first = await submission(control, "submit-replay-unbuildable", commit);
  const replay = await submission(control, "submit-replay-unbuildable", commit);

  expect(replay, "a replay reports the journaled label and the same build failure").toEqual(first);
  await expectActiveFixtureStillServing(control);
});

test("reusing a submission request ID for an activation fails", async () => {
  const control = await activeSupervisor("submit-reused-request-id");
  await seedCache(commits.reusedId);
  const result = await submission(control, "shared-id", commits.reusedId);
  const active = await control.getActiveGeneration();

  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/generations/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "shared-id",
        observedEpoch: active.epoch,
        label: submittedLabel(result),
      }),
    }),
    control,
  );

  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "reused-request-id" },
  });
  await expectActiveFixtureStillServing(control);
});
