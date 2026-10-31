import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../facet/fixture.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { artifact, prepareGeneration, storeModuleMap, submitCandidate } from "../helpers.js";
import { PI_DURABLE_VERSION } from "../../../src/pi-durable-version.js";
import { readGeneration, readGenerations } from "../generation-reads.js";

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
    ctx.storage.kv.put("checks", (ctx.storage.kv.get("checks") ?? 0) + 1);
  }
  piDurableVersion() {
    return this.ctx.storage.kv.get("checks") < 3 ? ${JSON.stringify(PI_DURABLE_VERSION)} : "0.0.1";
  }
}
`,
  );
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function submit(control: DurableObjectStub<Supervisor>, harnessCommit: string) {
  return control.controlGeneration({ kind: "submit-candidate", harnessCommit });
}

async function activate(control: DurableObjectStub<Supervisor>, label: number) {
  const active = await control.getActiveGeneration();

  return control.controlGeneration({ kind: "activate", label, observedEpoch: active.epoch });
}

afterEach(async () => {
  await reset();
});

test("submits the fixture harness commit as Generation 0 and the next commit as Generation 1", async () => {
  const control = supervisor("labels-generations");

  const first = await submit(control, fixtureMainHarnessCommit);
  const second = await submit(control, secondHarnessCommit);

  expect(first).toEqual({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: {
        label: 0,
        harnessCommit: fixtureMainHarnessCommit,
        status: "candidate",
      },
      epoch: 1,
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
  expect(await readGenerations(control)).toHaveLength(2);
});

test("a later preparation outcome replaces the recorded status", async () => {
  const control = supervisor("records-latest-preparation-outcome");
  const label = await submitCandidate(control, secondHarnessCommit);

  await storeModuleMap(control, stagedPreparationArtifact(secondHarnessCommit));
  const recorded = await control.prepareGeneration(label);
  const repeated = await control.prepareGeneration(label);
  const failed = await control.prepareGeneration(label);

  if (!recorded.ok || !repeated.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  expect(repeated).toEqual({
    ...recorded,
    report: { ...recorded.report, effect: "no-op" },
  });
  expect(failed).toMatchObject({
    ok: true,
    report: {
      stage: "version-mismatch",
      effect: "recorded",
      generation: { label, status: "failed" },
    },
  });
  expect(await readGeneration(control, label)).toMatchObject({ status: "failed" });
});

test("refuses a candidate submission that does not name a harness commit", async () => {
  const control = supervisor("rejects-malformed-commits");

  expect(await submit(control, "main")).toEqual({
    ok: false,
    problem: { code: "invalid-harness-commit" },
  });
  expect(await readGenerations(control), "a refused submission labels nothing").toHaveLength(0);
});

test("activates a ready generation once and preserves its epoch on a repeated request", async () => {
  const control = supervisor("activates-ready-generation");
  const label = await submitCandidate(control, secondHarnessCommit);
  await prepareGeneration(control, label, secondHarnessCommit);

  const prepared = await readGeneration(control, label);
  const activated = await activate(control, label);
  const repeated = await activate(control, label);

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
  });
  expect(repeated).toEqual({
    ...activated,
    outcome: { ...activated.outcome, effect: "no-op" },
  });
});

test("preserves generation state across eviction and labels nothing itself", async () => {
  const control = supervisor("persists-across-eviction");
  const label = await submitCandidate(control, thirdHarnessCommit);
  await prepareGeneration(control, label, thirdHarnessCommit);

  await evictDurableObject(control);

  expect(await readGenerations(control)).toEqual([
    { label: 0, harnessCommit: thirdHarnessCommit, status: "ready" },
  ]);
  expect(await control.getActiveGeneration()).toEqual({
    generation: undefined,
    epoch: 2,
  });
});
