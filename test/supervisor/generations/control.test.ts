import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { ActivationCommand } from "../../../src/supervisor/generations.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  prepareGeneration,
  submitCandidate,
  generationLabel,
  testHarnessCommit,
} from "../helpers.js";
import { readGenerations } from "../generation-reads.js";

const commits = {
  first: "0123456789abcdef0123456789abcdef01234567",
  second: "1123456789abcdef0123456789abcdef01234567",
  third: "2123456789abcdef0123456789abcdef01234567",
} as const;

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

async function readyGeneration(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  const label = await submitCandidate(control, harnessCommit);
  await prepareGeneration(control, label, harnessCommit);

  return label;
}

afterEach(async () => {
  await reset();
});

test.each([
  {
    name: "a stale activation request",
    code: "stale-epoch",
    command: (target: number, epoch: number): ActivationCommand => ({
      kind: "activate",
      label: generationLabel(target),
      observedEpoch: epoch - 1,
    }),
  },
  {
    name: "a stale rollback request",
    code: "stale-epoch",
    command: (_target: number, epoch: number): ActivationCommand => ({
      kind: "rollback",
      label: generationLabel(0),
      observedEpoch: epoch - 1,
    }),
  },
  {
    name: "an activation request for an unknown generation",
    code: "unknown-generation",
    command: (_target: number, epoch: number): ActivationCommand => ({
      kind: "activate",
      label: generationLabel(99),
      observedEpoch: epoch,
    }),
  },
])("$name is refused and leaves the active generation unchanged", async (refusal) => {
  const control = supervisor(`control-refused-${refusal.name.replaceAll(" ", "-")}`);
  await activateFixtureGeneration(control);
  const target = await readyGeneration(control, commits.first);
  const active = await control.getActiveGeneration();

  const result = await control.controlGeneration(refusal.command(target, active.epoch));

  expect(result).toEqual({ ok: false, problem: { code: refusal.code } });
  expect(await control.getActiveGeneration()).toEqual(active);
});

test("activation rejects unknown and unchecked generation targets with distinct codes", async () => {
  const control = supervisor("control-invalid-activation-targets");
  const epoch = await activateFixtureGeneration(control);
  const candidate = await submitCandidate(control, commits.first);

  const unknown = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(99),
    observedEpoch: epoch + 1,
  });

  const unchecked = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(candidate),
    observedEpoch: epoch + 1,
  });

  expect(unknown).toEqual({ ok: false, problem: { code: "unknown-generation" } });
  expect(unchecked).toEqual({ ok: false, problem: { code: "not-ready" } });
});

test("rollback requires a target generation that has been active before", async () => {
  const control = supervisor("control-rollback-history");
  await activateFixtureGeneration(control);
  const replacement = await readyGeneration(control, commits.first);
  const beforeActivation = await control.getActiveGeneration();

  const neverActive = await control.controlGeneration({
    kind: "rollback",
    label: generationLabel(replacement),
    observedEpoch: beforeActivation.epoch,
  });

  const activated = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(replacement),
    observedEpoch: beforeActivation.epoch,
  });

  if (!activated.ok) {
    throw new Error("a ready generation must accept an activation request");
  }

  const rolledBack = await control.controlGeneration({
    kind: "rollback",
    label: generationLabel(0),
    observedEpoch: activated.outcome.epoch,
  });

  expect(neverActive).toEqual({ ok: false, problem: { code: "not-previously-active" } });
  expect(rolledBack).toMatchObject({
    ok: true,
    outcome: { kind: "rolled-back", generation: { label: 0 } },
  });
});

test("activating the active generation with its current epoch is a no-op, but a stale epoch rejects", async () => {
  const control = supervisor("control-activate-no-op");
  await activateFixtureGeneration(control);
  const target = await readyGeneration(control, commits.first);
  const active = await control.getActiveGeneration();

  const activation: ActivationCommand = {
    kind: "activate",
    label: generationLabel(target),
    observedEpoch: active.epoch,
  };

  const first = await control.controlGeneration(activation);

  if (!first.ok) {
    throw new Error("a ready generation must accept its first activation");
  }

  const staleRepeat = await control.controlGeneration(activation);

  const currentRepeat = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(target),
    observedEpoch: first.outcome.epoch,
  });

  expect(first.outcome).toMatchObject({ kind: "activated", effect: "activated" });
  expect(staleRepeat, "the epoch the first activation observed is stale once committed").toEqual({
    ok: false,
    problem: { code: "stale-epoch" },
  });
  expect(
    currentRepeat,
    "activating the active label with its current epoch is a no-op",
  ).toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label: target }, effect: "no-op" },
  });
  expect(
    await control.getActiveGeneration(),
    "a no-op activation does not advance the epoch a second time",
  ).toMatchObject({
    generation: { label: target, status: "ready" },
    epoch: first.outcome.epoch,
  });
});

test("resubmitting the same harness commit still returns the existing generation after Durable Object eviction", async () => {
  const control = supervisor("control-resubmit-after-eviction");

  const first = await control.submitGeneration(testHarnessCommit(commits.third));
  await evictDurableObject(control);
  const resubmitted = await control.submitGeneration(testHarnessCommit(commits.third));

  expect(resubmitted).toEqual(first);
  expect(
    await readGenerations(control),
    "the generation table, not a request journal, is what survives eviction",
  ).toHaveLength(1);
});
