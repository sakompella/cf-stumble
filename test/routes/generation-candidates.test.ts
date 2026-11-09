import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../facet/fixture.js";
import type { GenerationSubmissionResult } from "../../src/routes/generations.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activeSupervisor,
  servedText,
  servingFacetSource,
  storeModuleMap,
} from "../supervisor/helpers.js";
import { readGeneration, readGenerations } from "../supervisor/generation-reads.js";
import { ownerApiResponse } from "./helpers.js";

const commits = {
  passing: "5100000000000000000000000000000000000001",
  unbuildable: "5100000000000000000000000000000000000002",
  rejecting: "5100000000000000000000000000000000000003",
  resubmitted: "5100000000000000000000000000000000000004",
  resubmittedUnbuildable: "5100000000000000000000000000000000000006",
} as const;

function seedModuleMap(harnessCommit: string, versionMethod?: string): Promise<void> {
  return storeModuleMap({
    harnessCommit,
    entryModule: "main.js",
    modules: [{ name: "main.js", source: servingFacetSource("candidate serving", versionMethod) }],
  });
}

function submit(control: DurableObjectStub<Supervisor>, harnessCommit: string): Promise<Response> {
  return ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnessCommit }),
    }),
    control,
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
  return result.outcome.generation.label;
}

async function expectActiveFixtureStillServing(
  control: DurableObjectStub<Supervisor>,
): Promise<void> {
  const active = await control.getActiveGeneration();
  expect(active.generation, "a candidate check must not replace active traffic").toMatchObject({
    label: 0,
    harnessCommit: fixtureMainHarnessCommit,
    status: "ready",
  });
  expect(await servedText(control)).toBe(fixtureMainHarnessCommit);
}

afterEach(async () => {
  await reset();
});

test("submits a passing candidate and leaves the active generation serving", async () => {
  const control = await activeSupervisor("submit-passing-candidate");
  await seedModuleMap(commits.passing);

  const result = await submission(control, commits.passing);

  expect(result).toMatchObject({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: { harnessCommit: commits.passing, status: "candidate" },
    },
    preparation: { ok: true, report: { stage: "ready", effect: "recorded" } },
  });
  expect(await readGeneration(control, submittedLabel(result))).toMatchObject({
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
    await readGeneration(control, submittedLabel(result)),
    "an unbuildable commit is no evidence about the candidate",
  ).toMatchObject({ harnessCommit: commits.unbuildable, status: "candidate" });
  await expectActiveFixtureStillServing(control);
});

test("records a candidate that fails its startup check and keeps the active generation", async () => {
  const control = await activeSupervisor("submit-failing-candidate");
  await seedModuleMap(commits.rejecting, `compatibility() { return "0.0.1"; }`);

  const result = await submission(control, commits.rejecting);
  const label = submittedLabel(result);

  expect(result).toMatchObject({
    ok: true,
    preparation: { ok: true, report: { stage: "compatibility-mismatch" } },
  });
  expect(await readGeneration(control, label)).toMatchObject({ label, status: "failed" });
  await expectActiveFixtureStillServing(control);
});

type Resubmission = readonly [
  name: string,
  commit: string,
  seeded: boolean,
  expected: (first: GenerationSubmissionResult) => object,
];

const resubmissions: readonly Resubmission[] = [
  [
    "a passing commit returns the existing ready generation",
    commits.resubmitted,
    true,
    (first) => ({
      ok: true,
      outcome: { generation: { ...first.outcome.generation, status: "ready" } },
      preparation: { ok: true, report: { stage: "ready", effect: "no-op" } },
    }),
  ],
  [
    "an unbuildable commit returns the same build failure",
    commits.resubmittedUnbuildable,
    false,
    (first) => first,
  ],
];

test.each(resubmissions)(
  "resubmitting %s without labeling it twice",
  async (_name, commit, seeded, expected) => {
    const control = await activeSupervisor(`submit-resubmit-${seeded ? "passing" : "unbuildable"}`);

    if (seeded) {
      await seedModuleMap(commit);
    }

    const first = await submission(control, commit);
    const resubmitted = await submission(control, commit);

    expect(resubmitted).toMatchObject(expected(first));
    expect(
      (await readGenerations(control)).filter((generation) => generation.harnessCommit === commit),
      "resubmitting a labeled commit must not label it twice",
    ).toHaveLength(1);
    await expectActiveFixtureStillServing(control);
  },
);
