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
import { ownerScope } from "./helpers.js";

const commits = {
  passing: "5100000000000000000000000000000000000001",
  unbuildable: "5100000000000000000000000000000000000002",
  rejecting: "5100000000000000000000000000000000000003",
  resubmitted: "5100000000000000000000000000000000000004",
  resubmittedUnbuildable: "5100000000000000000000000000000000000006",
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

function submit(control: DurableObjectStub<Supervisor>, harnessCommit: string): Promise<Response> {
  return routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/generations/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessCommit }),
    }),
    control,
    ownerScope,
  );
}

async function submission(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<GenerationSubmissionResult> {
  const response = await submit(control, harnessCommit);
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

  const result = await submission(control, commits.passing);

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

  const result = await submission(control, commits.unbuildable);

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

  const result = await submission(control, commits.rejecting);
  const label = submittedLabel(result);

  expect(result).toMatchObject({
    ok: true,
    preparation: { ok: true, report: { stage: "response-rejected", status: 500 } },
  });
  expect(await control.getGeneration(label)).toMatchObject({ label, status: "failed" });
  expect(await control.getPreparationCheckHistory(label)).toMatchObject([{ outcome: "failed" }]);
  await expectActiveFixtureStillServing(control);
});

test("resubmitting the same passing commit returns the existing generation without labeling it twice", async () => {
  const control = await activeSupervisor("submit-resubmit-passing");
  await seedCache(commits.resubmitted);

  const first = await submission(control, commits.resubmitted);
  const resubmitted = await submission(control, commits.resubmitted);

  expect(resubmitted).toMatchObject({
    ok: true,
    outcome: {
      // The commit keeps its label from the first submission. Its status has since moved on to
      // "ready", because the first submission's own preparation step already checked it.
      generation: first.ok ? { ...first.outcome.generation, status: "ready" } : undefined,
    },
  });
  expect(
    (await control.getGenerations()).filter(
      (generation) => generation.harnessCommit === commits.resubmitted,
    ),
    "resubmitting an already-labeled commit must not label it twice (ADR-0030)",
  ).toHaveLength(1);
  // The already-ready candidate's second preparation check confirms the recorded outcome rather
  // than recording it again: decidePreparationCheck reports a no-op, not a fresh recording.
  expect(resubmitted).toMatchObject({
    preparation: { ok: true, report: { stage: "ready", effect: "no-op" } },
  });
  await expectActiveFixtureStillServing(control);
});

test("resubmitting an unbuildable commit returns the same build failure, not a duplicate label", async () => {
  const control = await activeSupervisor("submit-resubmit-unbuildable");
  const commit = commits.resubmittedUnbuildable;

  const first = await submission(control, commit);
  const resubmitted = await submission(control, commit);

  expect(resubmitted, "an unbuildable commit reports the same failure on resubmission").toEqual(
    first,
  );
  expect(
    (await control.getGenerations()).filter((generation) => generation.harnessCommit === commit),
    "resubmitting an unbuildable commit must not label it twice",
  ).toHaveLength(1);
  await expectActiveFixtureStillServing(control);
});
