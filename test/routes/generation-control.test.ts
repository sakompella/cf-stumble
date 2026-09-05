/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  prepareFixtureGeneration,
  prepareGeneration,
  submitCandidate,
} from "../supervisor/helpers.js";
import { ownerScope } from "./helpers.js";

const commits = {
  second: "0123456789abcdef0123456789abcdef01234567",
  never: "1123456789abcdef0123456789abcdef01234567",
  candidate: "2123456789abcdef0123456789abcdef01234567",
} as const;

type ControlBody = {
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
    ownerScope,
  );
}

/** The epoch the owner page reads is the epoch an activation request must carry. */
async function statusEpoch(stub: DurableObjectStub<Supervisor>): Promise<number> {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/status"),
    stub,
    ownerScope,
  );
  const body = await response.json<{ readonly activeGeneration: { readonly epoch: number } }>();
  return body.activeGeneration.epoch;
}

async function readyFixture(name: string): Promise<DurableObjectStub<Supervisor>> {
  const stub = supervisor(name);
  const label = await prepareFixtureGeneration(stub);
  await control(stub, "activate", { observedEpoch: await statusEpoch(stub), label });
  return stub;
}

async function readySecond(stub: DurableObjectStub<Supervisor>, commit: string): Promise<number> {
  const label = await submitCandidate(stub, commit);
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

  const response = await control(stub, "activate", { observedEpoch, label });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label, status: "ready" }, effect: "activated" },
  });
  const active = await stub.getActiveGeneration();
  expect(active.generation?.label).toBe(label);
  expect(await statusEpoch(stub)).toBeGreaterThan(observedEpoch);
});

test("activating the already-active generation with the current epoch is a no-op", async () => {
  const stub = await readyFixture("routes-activate-no-op");
  const label = await readySecond(stub, commits.second);
  const observedEpoch = await statusEpoch(stub);

  const first = await (await control(stub, "activate", { observedEpoch, label })).json();
  const epochAfterFirst = await statusEpoch(stub);
  const repeated = await control(stub, "activate", { observedEpoch: epochAfterFirst, label });

  expect(repeated.status).toBe(200);
  await expect(repeated.json()).resolves.toMatchObject({
    ok: true,
    outcome: { kind: "activated", generation: { label }, effect: "no-op" },
  });
  expect(first).toMatchObject({ ok: true, outcome: { effect: "activated" } });
  expect(await statusEpoch(stub), "a no-op activation does not advance the epoch again").toBe(
    epochAfterFirst,
  );
});

test("repeating an activation with the epoch it already used is rejected as stale", async () => {
  const stub = await readyFixture("routes-activate-repeat-stale");
  const label = await readySecond(stub, commits.second);
  const observedEpoch = await statusEpoch(stub);
  const body = { observedEpoch, label };

  await control(stub, "activate", body);
  const repeated = await control(stub, "activate", body);

  expect(repeated.status).toBe(200);
  await expect(repeated.json()).resolves.toEqual({
    ok: false,
    problem: { code: "stale-epoch" },
  });
});

test("rejects an activation that carries a stale epoch", async () => {
  const stub = await readyFixture("routes-stale-epoch");
  const label = await readySecond(stub, commits.second);
  const stale = (await statusEpoch(stub)) - 1;

  const response = await control(stub, "activate", { observedEpoch: stale, label });

  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect((await stub.getActiveGeneration()).generation?.label).toBe(0);
});

test("rolls back to a ready generation that ran before", async () => {
  const stub = await readyFixture("routes-rollback");
  const label = await readySecond(stub, commits.second);
  await control(stub, "activate", { observedEpoch: await statusEpoch(stub), label });

  const response = await control(stub, "rollback", {
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
  const candidate = await submitCandidate(stub, commits.candidate);

  const untried = await control(stub, "rollback", {
    observedEpoch: await statusEpoch(stub),
    label: neverActive,
  });
  const notReady = await control(stub, "rollback", {
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
