import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations, type GenerationLabel } from "../../../src/supervisor/generations.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  fixtureMainHarnessCommit,
  generationLabel,
  readyArtifact,
  storeModuleMap,
  testHarnessCommit,
} from "../helpers.js";

const PREVIOUS_HOST_PROTOCOL = "pi-durable@1.4.0/host-1";

const secondCommit = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  await reset();
});

function command(kind: "activate" | "rollback", label: GenerationLabel, observedEpoch: number) {
  return { kind, label, observedEpoch };
}

function rollback(control: DurableObjectStub<Supervisor>, observedEpoch: number) {
  return control.controlGeneration({ kind: "rollback", label: generationLabel(0), observedEpoch });
}

function servedAcrossProtocols(storage: DurableObjectStorage): Generations {
  const before = new Generations(storage, PREVIOUS_HOST_PROTOCOL);
  const previous = { status: "ready", compatibility: PREVIOUS_HOST_PROTOCOL } as const;
  const first = before.submit(testHarnessCommit(fixtureMainHarnessCommit), "owner").generation;
  before.recordPreparation(first.label, previous, "owner");
  before.activate(command("activate", first.label, before.active().epoch), "owner");

  const after = new Generations(storage, FACET_COMPATIBILITY);
  const current = { status: "ready", compatibility: FACET_COMPATIBILITY } as const;
  const second = after.submit(testHarnessCommit(secondCommit), "owner").generation.label;
  after.recordPreparation(second, current, "owner");
  after.activate(command("activate", second, after.active().epoch), "owner");

  return after;
}

test("rollback refuses a generation prepared under the previous host protocol", async () => {
  const refused = await runInDurableObject(
    env.SUPERVISOR.getByName("rollback-across-protocols"),
    (_instance, state) => {
      const after = servedAcrossProtocols(state.storage);

      return {
        rollback: after.activate(
          command("rollback", generationLabel(0), after.active().epoch),
          "owner",
        ),
        active: after.active().generation?.label,
      };
    },
  );

  expect(refused).toEqual({
    rollback: { ok: false, problem: { code: "facet-compatibility-mismatch" } },
    active: 1,
  });
});

test("resubmitting the commit of a refused generation re-runs the check under the same label", async () => {
  const control = env.SUPERVISOR.getByName("resubmit-after-protocol-change");
  await storeModuleMap(readyArtifact(fixtureMainHarnessCommit));
  await storeModuleMap(readyArtifact(secondCommit));
  await runInDurableObject(control, (_instance, state) => {
    servedAcrossProtocols(state.storage);
  });

  const refused = await rollback(control, (await control.getActiveGeneration()).epoch);
  const resubmitted = await control.submitGeneration(testHarnessCommit(fixtureMainHarnessCommit));
  const rechecked = await control.prepareGeneration(resubmitted.generation.label);
  const rolledBack = await rollback(control, (await control.getActiveGeneration()).epoch);

  expect(refused).toEqual({ ok: false, problem: { code: "facet-compatibility-mismatch" } });
  expect(resubmitted.generation.label).toBe(0);
  expect(rechecked).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label: 0, status: "ready" }, effect: "recorded" },
  });
  expect(rolledBack).toMatchObject({
    ok: true,
    outcome: { kind: "rolled-back", generation: { label: 0 }, effect: "activated" },
  });
});
