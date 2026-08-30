/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type {
  GenerationCommand,
  GenerationRequest,
  Principal,
} from "../../src/supervisor/control.js";
import { fixtureMainHarnessCommit } from "../../src/agent/loader.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { activateGeneration, prepareGeneration, submitCandidate } from "./startup-check-helpers.js";

const commits = {
  first: "0123456789abcdef0123456789abcdef01234567",
  second: "1123456789abcdef0123456789abcdef01234567",
  third: "2123456789abcdef0123456789abcdef01234567",
} as const;

const user: Principal = { kind: "user" };

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function request(
  requestId: string,
  principal: Principal,
  command: GenerationCommand,
): GenerationRequest {
  return { requestId, principal, command };
}

async function activateFixture(control: DurableObjectStub<Supervisor>): Promise<number> {
  await prepareGeneration(control, 0, fixtureMainHarnessCommit);
  return activateGeneration(control, 0, "activate-fixture");
}

async function readyGeneration(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  const label = await submitCandidate(control, harnessCommit, `submit-${harnessCommit}`);
  await prepareGeneration(control, label, harnessCommit);
  return label;
}

afterEach(async () => {
  await reset();
});

test("a user submission labels its harness commit as a generation candidate", async () => {
  const control = supervisor("control-user-submission");

  const result = await control.controlGeneration(
    request("user-submission", user, { kind: "submit-candidate", harnessCommit: commits.first }),
  );

  expect(result).toMatchObject({
    ok: true,
    outcome: {
      kind: "candidate-submitted",
      generation: { label: 1, harnessCommit: commits.first, status: "candidate" },
    },
  });
});

test("the active harness can submit a generation candidate", async () => {
  const control = supervisor("control-active-harness-submission");
  await activateFixture(control);

  const result = await control.controlGeneration(
    request(
      "harness-submission",
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
  await activateFixture(control);
  const replacement = await readyGeneration(control, commits.first);
  await activateGeneration(control, replacement, "activate-replacement");

  const before = await control.getActiveGeneration();
  const result = await control.controlGeneration(
    request(
      "revoked-harness",
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
  await activateFixture(control);
  const target = await readyGeneration(control, commits.first);
  const active = await control.getActiveGeneration();

  const result = await control.controlGeneration(
    request("stale-activation", user, {
      kind: "activate",
      label: target,
      observedEpoch: active.epoch - 1,
    }),
  );

  expect(result).toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect(await control.getActiveGeneration()).toEqual(active);
});

test("activation rejects unknown and unchecked generation targets with distinct codes", async () => {
  const control = supervisor("control-invalid-activation-targets");
  const epoch = await activateFixture(control);
  const candidate = await submitCandidate(control, commits.first, "unchecked-candidate");

  const unknown = await control.controlGeneration(
    request("unknown-activation", user, { kind: "activate", label: 99, observedEpoch: epoch + 1 }),
  );
  const unchecked = await control.controlGeneration(
    request("candidate-activation", user, {
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
  await activateFixture(control);
  const replacement = await readyGeneration(control, commits.first);
  const beforeActivation = await control.getActiveGeneration();

  const neverActive = await control.controlGeneration(
    request("never-active-rollback", user, {
      kind: "rollback",
      label: replacement,
      observedEpoch: beforeActivation.epoch,
    }),
  );
  const activated = await control.controlGeneration(
    request("activate-replacement", user, {
      kind: "activate",
      label: replacement,
      observedEpoch: beforeActivation.epoch,
    }),
  );
  if (!activated.ok) {
    throw new Error("a ready generation must accept an activation request");
  }

  const rolledBack = await control.controlGeneration(
    request("rollback-fixture", user, {
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

test("replaying an activation request preserves the recorded epoch", async () => {
  const control = supervisor("control-replayed-activation");
  await activateFixture(control);
  const target = await readyGeneration(control, commits.first);
  const active = await control.getActiveGeneration();
  const activation = request("replayed-activation", user, {
    kind: "activate",
    label: target,
    observedEpoch: active.epoch,
  });

  const first = await control.controlGeneration(activation);
  const second = await control.controlGeneration(activation);

  expect(second).toEqual(first);
  expect(
    await control.getActiveGeneration(),
    "a replayed request must not increment the epoch a second time",
  ).toMatchObject({
    generation: { label: target },
    epoch: first.ok ? first.outcome.epoch : undefined,
  });
});

test("a request ID cannot be reused for a different command", async () => {
  const control = supervisor("control-reused-request-id");

  await control.controlGeneration(
    request("reused-request-id", user, { kind: "submit-candidate", harnessCommit: commits.first }),
  );
  const result = await control.controlGeneration(
    request("reused-request-id", user, { kind: "submit-candidate", harnessCommit: commits.second }),
  );

  expect(result).toEqual({ ok: false, problem: { code: "reused-request-id" } });
  expect(await control.getGenerations()).toHaveLength(2);
});

test("a rejected request replay returns its terminal rejection", async () => {
  const control = supervisor("control-replayed-rejection");
  const rejectedRequest = request("replayed-rejection", user, {
    kind: "activate",
    label: 99,
    observedEpoch: 0,
  });

  const first = await control.controlGeneration(rejectedRequest);
  const second = await control.controlGeneration(rejectedRequest);

  expect(first).toEqual({ ok: false, problem: { code: "unknown-generation" } });
  expect(second).toEqual(first);
});

test("the durable journal returns a recorded outcome after Durable Object eviction", async () => {
  const control = supervisor("control-journal-after-eviction");
  const submission = request("evicted-submission", user, {
    kind: "submit-candidate",
    harnessCommit: commits.third,
  });

  const first = await control.controlGeneration(submission);
  await evictDurableObject(control);
  const replayed = await control.controlGeneration(submission);

  expect(replayed).toEqual(first);
  expect(await control.getGenerations()).toHaveLength(2);
});
