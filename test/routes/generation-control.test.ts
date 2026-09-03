/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { fixtureMainHarnessCommit } from "../../src/facet/index.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { prepareGeneration, submitCandidate } from "../supervisor/helpers.js";

const commits = {
  second: "0123456789abcdef0123456789abcdef01234567",
  never: "1123456789abcdef0123456789abcdef01234567",
  candidate: "2123456789abcdef0123456789abcdef01234567",
} as const;

type ControlBody = {
  readonly requestId: string;
  readonly observedEpoch: number;
  readonly label: number;
};

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function control(
  stub: DurableObjectStub<Supervisor>,
  command: "activate" | "rollback",
  body: ControlBody,
): Promise<Response> {
  return routeOwnerApiRequest(
    new Request(`https://cf-stumble.test/api/generations/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    stub,
  );
}

/** The epoch the owner page reads is the epoch an activation request must carry. */
async function statusEpoch(stub: DurableObjectStub<Supervisor>): Promise<number> {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/status"),
    stub,
  );
  const body = await response.json<{ readonly activeGeneration: { readonly epoch: number } }>();
  return body.activeGeneration.epoch;
}

async function readyFixture(name: string): Promise<DurableObjectStub<Supervisor>> {
  const stub = supervisor(name);
  await prepareGeneration(stub, 0, fixtureMainHarnessCommit);
  await control(stub, "activate", {
    requestId: "activate-fixture",
    observedEpoch: await statusEpoch(stub),
    label: 0,
  });
  return stub;
}

async function readySecond(stub: DurableObjectStub<Supervisor>, commit: string): Promise<number> {
  const label = await submitCandidate(stub, commit, `submit-${commit}`);
  await prepareGeneration(stub, label, commit);
  return label;
}

afterEach(async () => {
  await reset();
});

test("activates a ready generation against the epoch the status route reports", async () => {
  const stub = await readyFixture("routes-activate");
  const label = await readySecond(stub, commits.second);
  const observedEpoch = await statusEpoch(stub);

  const response = await control(stub, "activate", {
    requestId: "activate-1",
    observedEpoch,
    label,
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label, status: "ready" }, effect: "activated" },
  });
  const active = await stub.getActiveGeneration();
  expect(active.generation?.label).toBe(label);
  expect(await statusEpoch(stub)).toBeGreaterThan(observedEpoch);
});

test("replaying one request ID returns the journaled result and applies nothing", async () => {
  const stub = await readyFixture("routes-activate-replay");
  const label = await readySecond(stub, commits.second);
  const observedEpoch = await statusEpoch(stub);
  const body = { requestId: "activate-replay", observedEpoch, label };

  const first = await (await control(stub, "activate", body)).json();
  const epochAfterFirst = await statusEpoch(stub);
  const replay = await control(stub, "activate", body);

  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toEqual(first);
  expect(await statusEpoch(stub)).toBe(epochAfterFirst);
});

test("reusing an activation request ID for a rollback fails", async () => {
  const stub = await readyFixture("routes-reused-request-id");
  const label = await readySecond(stub, commits.second);
  const observedEpoch = await statusEpoch(stub);
  await control(stub, "activate", { requestId: "shared-id", observedEpoch, label });

  const response = await control(stub, "rollback", {
    requestId: "shared-id",
    observedEpoch: await statusEpoch(stub),
    label: 0,
  });

  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "reused-request-id" },
  });
  expect((await stub.getActiveGeneration()).generation?.label).toBe(label);
});

test("rejects an activation that carries a stale epoch", async () => {
  const stub = await readyFixture("routes-stale-epoch");
  const label = await readySecond(stub, commits.second);
  const stale = (await statusEpoch(stub)) - 1;

  const response = await control(stub, "activate", {
    requestId: "stale",
    observedEpoch: stale,
    label,
  });

  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect((await stub.getActiveGeneration()).generation?.label).toBe(0);
});

test("rolls back to a ready generation that ran before", async () => {
  const stub = await readyFixture("routes-rollback");
  const label = await readySecond(stub, commits.second);
  await control(stub, "activate", {
    requestId: "activate-second",
    observedEpoch: await statusEpoch(stub),
    label,
  });

  const response = await control(stub, "rollback", {
    requestId: "rollback-1",
    observedEpoch: await statusEpoch(stub),
    label: 0,
  });

  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    outcome: { kind: "rolled-back", generation: { label: 0 }, effect: "activated" },
  });
  expect((await stub.getActiveGeneration()).generation?.label).toBe(0);
});

test("refuses to roll back to a generation that never ran or is not ready", async () => {
  const stub = await readyFixture("routes-rollback-refusals");
  const neverActive = await readySecond(stub, commits.never);
  const candidate = await submitCandidate(stub, commits.candidate, "submit-candidate");

  const untried = await control(stub, "rollback", {
    requestId: "rollback-never-active",
    observedEpoch: await statusEpoch(stub),
    label: neverActive,
  });
  const notReady = await control(stub, "rollback", {
    requestId: "rollback-candidate",
    observedEpoch: await statusEpoch(stub),
    label: candidate,
  });

  await expect(untried.json()).resolves.toEqual({
    ok: false,
    problem: { code: "not-previously-active" },
  });
  await expect(notReady.json()).resolves.toEqual({ ok: false, problem: { code: "not-ready" } });
  expect((await stub.getActiveGeneration()).generation?.label).toBe(0);
});
