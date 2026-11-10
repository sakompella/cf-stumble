import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../facet/fixture.js";
import { Generations } from "../../../src/supervisor/generations.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { prepareGeneration, submitCandidate, testHarnessCommit } from "../helpers.js";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { readGenerations } from "../generation-reads.js";

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";

const thirdHarnessCommit = "1123456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function submit(control: DurableObjectStub<Supervisor>, harnessCommit: string) {
  return control.submitGeneration(testHarnessCommit(harnessCommit));
}

afterEach(async () => {
  await reset();
});

test("submits the fixture harness commit as Generation 0 and the next commit as Generation 1", async () => {
  const control = supervisor("labels-generations");

  const first = await submit(control, fixtureMainHarnessCommit);
  const second = await submit(control, secondHarnessCommit);

  expect(first).toEqual({
    kind: "candidate-submitted",
    generation: { label: 0, harnessCommit: fixtureMainHarnessCommit, status: "candidate" },
    epoch: 1,
  });
  expect(second).toMatchObject({
    kind: "candidate-submitted",
    generation: { label: 1, harnessCommit: secondHarnessCommit, status: "candidate" },
    epoch: 2,
  });
  expect(await readGenerations(control)).toHaveLength(2);
});

test("a later preparation outcome replaces the recorded status, and a repeated one is a no-op", async () => {
  const outcome = await runInDurableObject(
    supervisor("records-latest-preparation-outcome"),
    (_instance, state) => {
      const generations = new Generations(state.storage, FACET_COMPATIBILITY);
      const { label } = generations.submit(testHarnessCommit(secondHarnessCommit)).generation;
      const ready = { status: "ready", compatibility: FACET_COMPATIBILITY } as const;

      return {
        recorded: generations.recordPreparation(label, ready),
        repeated: generations.recordPreparation(label, ready),
        failed: generations.recordPreparation(label, { status: "failed" }),
        stored: generations.byLabel(label)?.status,
      };
    },
  );

  expect(outcome).toMatchObject({
    recorded: { generation: { status: "ready" }, epoch: 2, effect: "recorded" },
    repeated: { generation: { status: "ready" }, epoch: 2, effect: "no-op" },
    failed: { generation: { status: "failed" }, epoch: 3, effect: "recorded" },
    stored: "failed",
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
