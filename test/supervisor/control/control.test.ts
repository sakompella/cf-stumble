/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type {
  GenerationCommand,
  GenerationRequest,
  Principal,
} from "../../../src/supervisor/control/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateFixtureGeneration,
  activateGeneration,
  prepareGeneration,
  submitCandidate,
} from "../helpers.js";

const commits = {
  first: "0123456789abcdef0123456789abcdef01234567",
  second: "1123456789abcdef0123456789abcdef01234567",
  third: "2123456789abcdef0123456789abcdef01234567",
} as const;

const user: Principal = { kind: "user" };

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function request(principal: Principal, command: GenerationCommand): GenerationRequest {
  return { principal, command };
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

test("a user submission labels its harness commit as a generation candidate", async () => {
  const control = supervisor("control-user-submission");

  const result = await control.controlGeneration(
    request(user, { kind: "submit-candidate", harnessCommit: commits.first }),
  );

  expect(result).toMatchObject({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: { label: 0, harnessCommit: commits.first, status: "candidate" },
    },
  });
});

test("resubmitting the same harness commit returns the existing generation", async () => {
  const control = supervisor("control-resubmit-existing");
  const submission = request(user, { kind: "submit-candidate", harnessCommit: commits.first });

  const first = await control.controlGeneration(submission);
  const resubmitted = await control.controlGeneration(submission);

  expect(resubmitted).toEqual(first);
  expect(
    await control.getGenerations(),
    "labeling an already-labeled commit again must not add a second row (ADR-0030)",
  ).toHaveLength(1);
});

test("an invalid harness generation label cannot submit before activation", async () => {
  const control = supervisor("control-invalid-harness-label-before-activation");

  const requestWithInvalidLabel = request(
    { kind: "harness", generationLabel: -1 },
    { kind: "submit-candidate", harnessCommit: commits.first },
  );

  const result = await control.controlGeneration(requestWithInvalidLabel);

  expect(result).toEqual({ ok: false, problem: { code: "revoked-capability" } });
  expect(await control.getGenerations(), "a revoked request must label nothing").toHaveLength(0);
  expect(await control.controlGeneration(requestWithInvalidLabel)).toEqual(result);
});

test("the active harness can submit a generation candidate", async () => {
  const control = supervisor("control-active-harness-submission");
  await activateFixtureGeneration(control);

  const result = await control.controlGeneration(
    request(
      { kind: "harness", generationLabel: 0 },
      {
        kind: "submit-candidate",
        harnessCommit: commits.first,
      },
    ),
  );

  expect(result).toMatchObject({
    ok: true,
    outcome: { kind: "candidate-submitted", generation: { harnessCommit: commits.first } },
  });
});

test("a replaced harness cannot submit a candidate through its revoked capability", async () => {
  const control = supervisor("control-revoked-harness");
  await activateFixtureGeneration(control);
  const replacement = await readyGeneration(control, commits.first);
  await activateGeneration(control, replacement);

  const before = await control.getActiveGeneration();

  const result = await control.controlGeneration(
    request(
      { kind: "harness", generationLabel: 0 },
      {
        kind: "submit-candidate",
        harnessCommit: commits.second,
      },
    ),
  );

  expect(result).toEqual({ ok: false, problem: { code: "revoked-capability" } });
  expect(
    await control.getActiveGeneration(),
    "a revoked request must not move the active generation",
  ).toEqual(before);
  expect(
    await control.getGenerations(),
    "a revoked request must not label another generation",
  ).toHaveLength(2);
});

test("a stale activation request leaves the active generation unchanged", async () => {
  const control = supervisor("control-stale-activation");
  await activateFixtureGeneration(control);
  const target = await readyGeneration(control, commits.first);
  const active = await control.getActiveGeneration();

  const result = await control.controlGeneration(
    request(user, {
      kind: "activate",
      label: target,
      observedEpoch: active.epoch - 1,
    }),
  );

  expect(result).toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect(await control.getActiveGeneration()).toEqual(active);
});

test("rejects an invalid generation-label RPC input with its existing error code", async () => {
  const control = supervisor("control-invalid-generation-label");

  expect(
    await control.controlGeneration(
      request(user, {
        kind: "activate",
        label: -1,
        observedEpoch: 0,
      }),
    ),
  ).toEqual({ ok: false, problem: { code: "invalid-generation-label" } });
});

test("activation rejects unknown and unchecked generation targets with distinct codes", async () => {
  const control = supervisor("control-invalid-activation-targets");
  const epoch = await activateFixtureGeneration(control);
  const candidate = await submitCandidate(control, commits.first);

  const unknown = await control.controlGeneration(
    request(user, { kind: "activate", label: 99, observedEpoch: epoch + 1 }),
  );

  const unchecked = await control.controlGeneration(
    request(user, {
      kind: "activate",
      label: candidate,
      observedEpoch: epoch + 1,
    }),
  );

  expect(unknown).toEqual({ ok: false, problem: { code: "unknown-generation" } });
  expect(unchecked).toEqual({ ok: false, problem: { code: "not-ready" } });
});

test("rollback requires a target generation that has been active before", async () => {
  const control = supervisor("control-rollback-history");
  await activateFixtureGeneration(control);
  const replacement = await readyGeneration(control, commits.first);
  const beforeActivation = await control.getActiveGeneration();

  const neverActive = await control.controlGeneration(
    request(user, {
      kind: "rollback",
      label: replacement,
      observedEpoch: beforeActivation.epoch,
    }),
  );

  const activated = await control.controlGeneration(
    request(user, {
      kind: "activate",
      label: replacement,
      observedEpoch: beforeActivation.epoch,
    }),
  );

  if (!activated.ok) {
    throw new Error("a ready generation must accept an activation request");
  }

  const rolledBack = await control.controlGeneration(
    request(user, {
      kind: "rollback",
      label: 0,
      observedEpoch: activated.outcome.epoch,
    }),
  );

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

  const activation = request(user, {
    kind: "activate",
    label: target,
    observedEpoch: active.epoch,
  });

  const first = await control.controlGeneration(activation);

  if (!first.ok) {
    throw new Error("a ready generation must accept its first activation");
  }

  const staleRepeat = await control.controlGeneration(activation);

  const currentRepeat = await control.controlGeneration(
    request(user, { kind: "activate", label: target, observedEpoch: first.outcome.epoch }),
  );

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
  ).toMatchObject({ generation: { label: target }, epoch: first.outcome.epoch });
});

test("repeating a rejected command against unchanged state returns the same rejection", async () => {
  const control = supervisor("control-repeat-rejection");

  const rejectedRequest = request(user, {
    kind: "activate",
    label: 99,
    observedEpoch: 0,
  });

  const first = await control.controlGeneration(rejectedRequest);
  const repeated = await control.controlGeneration(rejectedRequest);

  expect(first).toEqual({ ok: false, problem: { code: "unknown-generation" } });
  expect(repeated).toEqual(first);
});

test("resubmitting the same harness commit still returns the existing generation after Durable Object eviction", async () => {
  const control = supervisor("control-resubmit-after-eviction");

  const submission = request(user, {
    kind: "submit-candidate",
    harnessCommit: commits.third,
  });

  const first = await control.controlGeneration(submission);
  await evictDurableObject(control);
  const resubmitted = await control.controlGeneration(submission);

  expect(resubmitted).toEqual(first);
  expect(
    await control.getGenerations(),
    "the generation table, not a request journal, is what survives eviction (ADR-0030)",
  ).toHaveLength(1);
});
