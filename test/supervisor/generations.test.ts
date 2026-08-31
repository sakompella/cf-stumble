/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { artifact, prepareGeneration, submitCandidate } from "./helpers.js";

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";
const thirdHarnessCommit = "1123456789abcdef0123456789abcdef01234567";

function stagedPreparationArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS checks (count INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT INTO checks (count) VALUES (1)");
  }
  fetch() {
    const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM checks").one().count;
    return new Response("check " + count, { status: count < 3 ? 200 : 500 });
  }
}
`,
  );
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function submit(control: DurableObjectStub<Supervisor>, requestId: string, harnessCommit: string) {
  return control.controlGeneration({
    requestId,
    principal: { kind: "user" },
    command: { kind: "submit-candidate", harnessCommit },
  });
}

async function activate(control: DurableObjectStub<Supervisor>, requestId: string, label: number) {
  const active = await control.getActiveGeneration();
  return control.controlGeneration({
    requestId,
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: active.epoch },
  });
}

afterEach(async () => {
  await reset();
});

test("submits the fixture harness commit as Generation 0 and the next commit as Generation 1", async () => {
  const control = supervisor("labels-generations");

  const first = await submit(control, "submit-fixture", fixtureMainHarnessCommit);
  const second = await submit(control, "submit-second", secondHarnessCommit);

  expect(first).toEqual({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: {
        label: 0,
        harnessCommit: fixtureMainHarnessCommit,
        status: "candidate",
      },
      epoch: 0,
    },
  });
  expect(second).toMatchObject({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: {
        label: 1,
        harnessCommit: secondHarnessCommit,
        status: "candidate",
      },
    },
  });
  expect(await control.getGenerations()).toHaveLength(2);
});

test("submitting an existing harness commit preserves its label count and epoch", async () => {
  const control = supervisor("labels-idempotently");

  const first = await submit(control, "submit-first", secondHarnessCommit);
  const repeated = await submit(control, "submit-repeated", secondHarnessCommit);

  expect(repeated).toEqual(first);
  expect(await control.getGenerations()).toHaveLength(2);
});

test("keeps the first preparation outcome and refuses a later contradicting one", async () => {
  const control = supervisor("records-one-preparation-outcome");
  const label = await submitCandidate(control, secondHarnessCommit, "submit-candidate");

  const preparationArtifact = stagedPreparationArtifact(secondHarnessCommit);
  const recorded = await control.checkGenerationStartup(label, preparationArtifact);
  const repeated = await control.checkGenerationStartup(label, preparationArtifact);
  const contradicted = await control.checkGenerationStartup(label, preparationArtifact);

  if (!recorded.ok || !repeated.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  expect(repeated).toEqual({
    ...recorded,
    report: { ...recorded.report, effect: "no-op" },
  });
  expect(
    contradicted,
    "a second, different outcome is a real event and must not be swallowed",
  ).toEqual({
    ok: false,
    problem: {
      code: "contradicts-recorded-outcome",
      label,
      recorded: "ready",
    },
  });
  expect(await control.getGeneration(label)).toEqual(recorded.report.generation);
  const history = await control.getPreparationCheckHistory(label);

  expect(
    history.map((check) => check.outcome),
    "a refused check is not evidence and must leave no record behind",
  ).toEqual(["passed", "passed"]);
});

test("refuses a candidate submission that does not name a harness commit", async () => {
  const control = supervisor("rejects-malformed-commits");

  expect(await submit(control, "submit-malformed", "main")).toEqual({
    ok: false,
    problem: { code: "invalid-harness-commit" },
  });
  expect(await control.getGenerations(), "only the seeded Generation 0 may exist").toHaveLength(1);
});

test("rejects unknown and candidate generations without throwing during activation", async () => {
  const control = supervisor("rejects-unready-generations");

  expect(await activate(control, "activate-unknown", 99)).toEqual({
    ok: false,
    problem: { code: "unknown-generation" },
  });
  expect(await activate(control, "activate-candidate", 0)).toEqual({
    ok: false,
    problem: { code: "not-ready" },
  });
});

test("activates a ready generation once and preserves its epoch on a repeated request", async () => {
  const control = supervisor("activates-ready-generation");
  const label = await submitCandidate(control, secondHarnessCommit, "submit-candidate");
  await prepareGeneration(control, label, secondHarnessCommit);

  const prepared = await control.getGeneration(label);
  const activated = await activate(control, "activate-ready", label);
  const repeated = await activate(control, "activate-ready-again", label);
  if (!activated.ok || !repeated.ok || prepared === undefined) {
    throw new Error("a ready generation must be activatable");
  }

  expect(activated).toMatchObject({
    ok: true,
    outcome: {
      kind: "activated",
      generation: { label, status: "ready" },
      effect: "activated",
    },
  });
  expect(await control.getActiveGeneration()).toEqual({
    generation: prepared,
    epoch: activated.outcome.epoch,
    activationId: 1,
  });
  expect(repeated).toEqual({
    ...activated,
    outcome: { ...activated.outcome, effect: "no-op" },
  });
});

test("keeps branded generation identities plain through structured clone and eviction", async () => {
  const control = supervisor("cloneable-generation-identities");
  await submitCandidate(control, secondHarnessCommit, "submit-cloneable-generation");
  const beforeEviction = await control.getGenerations();

  expect(structuredClone(beforeEviction)).toEqual(beforeEviction);

  await evictDurableObject(control);

  expect(await control.getGenerations()).toEqual(beforeEviction);
});

test("preserves generation state across eviction without reseeding Generation 0", async () => {
  const control = supervisor("persists-across-eviction");
  const label = await submitCandidate(control, thirdHarnessCommit, "submit-candidate");
  await prepareGeneration(control, label, thirdHarnessCommit);

  await evictDurableObject(control);

  expect(await control.getGenerations()).toEqual([
    { label: 0, harnessCommit: fixtureMainHarnessCommit, status: "candidate" },
    { label: 1, harnessCommit: thirdHarnessCommit, status: "ready" },
  ]);
  expect(await control.getActiveGeneration()).toEqual({
    generation: undefined,
    epoch: 2,
  });
});
