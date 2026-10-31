import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { PI_DURABLE_VERSION } from "../../../src/pi-durable-version.js";
import { Generations } from "../../../src/supervisor/generations.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  activateGeneration,
  fixtureMainHarnessCommit,
  generationLabel,
  prepareGeneration,
  submitCandidate,
  testHarnessCommit,
} from "../helpers.js";

const EARLIER_VERSION = "0.0.1-earlier";

const secondCommit = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  await reset();
});

function rollback(control: DurableObjectStub<Supervisor>, observedEpoch: number) {
  return control.controlGeneration({ kind: "rollback", label: generationLabel(0), observedEpoch });
}

test("rollback refuses a generation prepared under another Pi Durable version", async () => {
  const refused = await runInDurableObject(
    env.SUPERVISOR.getByName("rollback-across-versions"),
    (_instance, state) => {
      const before = new Generations(state.storage, EARLIER_VERSION);
      const first = before.submit(testHarnessCommit(fixtureMainHarnessCommit)).generation.label;
      before.recordPreparation(first, { status: "ready", piDurableVersion: EARLIER_VERSION });
      before.activate({ kind: "activate", label: first, observedEpoch: before.active().epoch });

      const after = new Generations(state.storage, PI_DURABLE_VERSION);
      const second = after.submit(testHarnessCommit(secondCommit)).generation.label;
      after.recordPreparation(second, { status: "ready", piDurableVersion: PI_DURABLE_VERSION });
      after.activate({ kind: "activate", label: second, observedEpoch: after.active().epoch });

      return {
        rollback: after.activate({
          kind: "rollback",
          label: first,
          observedEpoch: after.active().epoch,
        }),
        active: after.active().generation?.label,
      };
    },
  );

  expect(refused).toEqual({
    rollback: { ok: false, problem: { code: "pi-durable-version-mismatch" } },
    active: 1,
  });
});

test("resubmitting the commit of a refused generation re-runs the check under the same label", async () => {
  const control = env.SUPERVISOR.getByName("resubmit-after-version-change");
  await activateFixtureGeneration(control);
  const second = await submitCandidate(control, secondCommit);
  await prepareGeneration(control, second, secondCommit);
  await activateGeneration(control, second);

  await runInDurableObject(control, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE generations SET pi_durable_version = ? WHERE label = 0",
      EARLIER_VERSION,
    );
  });

  const refused = await rollback(control, (await control.getActiveGeneration()).epoch);
  const resubmitted = await control.submitGeneration(testHarnessCommit(fixtureMainHarnessCommit));
  const rechecked = await control.prepareGeneration(resubmitted.generation.label);
  const rolledBack = await rollback(control, (await control.getActiveGeneration()).epoch);

  expect(refused).toEqual({ ok: false, problem: { code: "pi-durable-version-mismatch" } });
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
