/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

const secondHarnessCommit = "0123456789abcdef0123456789abcdef01234567";
const thirdHarnessCommit = "1123456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("labels the fixture harness commit as Generation 0 and the next commit as Generation 1", async () => {
  const control = supervisor("labels-generations");

  const first = await control.labelGeneration(fixtureMainHarnessCommit);
  const second = await control.labelGeneration(secondHarnessCommit);

  expect(first).toEqual({
    ok: true,
    generation: {
      label: 0,
      harnessCommit: fixtureMainHarnessCommit,
      status: "candidate",
    },
    epoch: 0,
  });
  expect(second).toMatchObject({
    ok: true,
    generation: {
      label: 1,
      harnessCommit: secondHarnessCommit,
      status: "candidate",
    },
  });
  expect(await control.getGenerations()).toHaveLength(2);
});

test("labeling an existing harness commit preserves its label count and epoch", async () => {
  const control = supervisor("labels-idempotently");

  const first = await control.labelGeneration(secondHarnessCommit);
  const repeated = await control.labelGeneration(secondHarnessCommit);

  expect(repeated).toEqual(first);
  expect(await control.getGenerations()).toHaveLength(2);
});

test("keeps the first preparation outcome and refuses a later contradicting one", async () => {
  const control = supervisor("records-one-preparation-outcome");
  const labeled = await control.labelGeneration(secondHarnessCommit);

  if (!labeled.ok) {
    throw new Error("a harness commit must be labelable");
  }

  const recorded = await control.recordPreparationCheck(labeled.generation.label, "passed");
  const repeated = await control.recordPreparationCheck(labeled.generation.label, "passed");
  const contradicted = await control.recordPreparationCheck(labeled.generation.label, "failed");

  if (!recorded.ok || !repeated.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  expect(repeated).toEqual({ ...recorded, effect: "no-op" });
  expect(
    contradicted,
    "a second, different outcome is a real event and must not be swallowed",
  ).toEqual({
    ok: false,
    problem: {
      code: "contradicts-recorded-outcome",
      label: labeled.generation.label,
      recorded: "ready",
    },
  });
  expect(await control.getGeneration(labeled.generation.label)).toEqual(recorded.generation);
  const history = await control.getPreparationCheckHistory(labeled.generation.label);

  expect(
    history.map((check) => check.outcome),
    "a refused check is not evidence and must leave no record behind",
  ).toEqual(["passed", "passed"]);
});

test("refuses to label a value that is not a harness commit", async () => {
  const control = supervisor("rejects-malformed-commits");

  expect(await control.labelGeneration("main")).toEqual({
    ok: false,
    problem: { code: "invalid-harness-commit", harnessCommit: "main" },
  });
  expect(await control.getGenerations(), "only the seeded Generation 0 may exist").toHaveLength(1);
});

test("rejects unknown and candidate generations without throwing during activation", async () => {
  const control = supervisor("rejects-unready-generations");

  expect(await control.activateGeneration(99)).toEqual({
    ok: false,
    problem: { code: "unknown-generation", label: 99 },
  });
  expect(await control.activateGeneration(0)).toEqual({
    ok: false,
    problem: { code: "not-ready", label: 0 },
  });
});

test("activates a ready generation once and preserves its epoch on a repeated request", async () => {
  const control = supervisor("activates-ready-generation");
  const labeled = await control.labelGeneration(secondHarnessCommit);

  if (!labeled.ok) {
    throw new Error("a harness commit must be labelable");
  }

  const prepared = await control.recordPreparationCheck(labeled.generation.label, "passed");
  if (!prepared.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  const activated = await control.activateGeneration(labeled.generation.label);
  const repeated = await control.activateGeneration(labeled.generation.label);
  if (!activated.ok || !repeated.ok) {
    throw new Error("a ready generation must be activatable");
  }

  expect(activated).toMatchObject({
    ok: true,
    generation: { label: labeled.generation.label, status: "ready" },
    effect: "activated",
  });
  expect(await control.getActiveGeneration()).toEqual({
    generation: prepared.generation,
    epoch: activated.epoch,
    activationId: 1,
  });
  expect(repeated).toEqual({ ...activated, effect: "no-op" });
});

test("preserves generation state across eviction without reseeding Generation 0", async () => {
  const control = supervisor("persists-across-eviction");
  const labeled = await control.labelGeneration(thirdHarnessCommit);

  if (!labeled.ok) {
    throw new Error("a harness commit must be labelable");
  }

  const prepared = await control.recordPreparationCheck(labeled.generation.label, "passed");
  if (!prepared.ok) {
    throw new Error("a labeled generation must accept its first preparation check");
  }

  await evictDurableObject(control);

  expect(await control.getGenerations()).toEqual([
    { label: 0, harnessCommit: fixtureMainHarnessCommit, status: "candidate" },
    { label: 1, harnessCommit: thirdHarnessCommit, status: "ready" },
  ]);
  expect(await control.getActiveGeneration()).toEqual({
    generation: undefined,
    epoch: prepared.epoch,
  });
});
