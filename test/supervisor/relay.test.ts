/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

async function activeSupervisor(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = supervisor(name);
  const prepared = await control.recordPreparationCheck(0, "passed");
  if (!prepared.ok) {
    throw new Error("Generation 0 must accept its preparation check");
  }

  const activated = await control.activateGeneration(0);
  if (!activated.ok) {
    throw new Error("Generation 0 must become active");
  }

  return control;
}

function relayRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://cf-stumble.test${path}`, init);
}

afterEach(async () => {
  await reset();
});

test("relays an ordinary request and response without changing either side", async () => {
  const control = await activeSupervisor("relay-preserves-http");
  const response = await control.fetch(
    relayRequest("/facet/relay/echo?query=preserved", {
      method: "POST",
      headers: { "x-request-header": "request header" },
      body: "request body",
    }),
  );

  expect(response.status).toBe(201);
  expect(response.headers.get("x-facet-method")).toBe("POST");
  expect(response.headers.get("x-facet-path")).toBe("/facet/relay/echo");
  expect(response.headers.get("x-facet-request-header")).toBe("request header");
  expect(response.headers.get("x-facet-response-header")).toBe("preserved");
  expect(await response.text()).toBe("request body");
  expect(await control.getRelayFacts()).toMatchObject([
    { kind: "headers-received", responseStatus: 201 },
    { kind: "body-completed", responseStatus: 201 },
  ]);
});

test("records a facet failure before headers and returns an error response", async () => {
  const control = await activeSupervisor("relay-pre-header-failure");
  const response = await control.fetch(relayRequest("/facet/relay/pre-header-failure"));

  expect(response.status).toBe(502);
  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "pre-header-failure", responseStatus: undefined },
  ]);
  expect(await control.getRelayFacts()).toMatchObject([{ kind: "pre-header-failure" }]);
});

test("records a body failure after 200 headers rather than crediting its status", async () => {
  const control = await activeSupervisor("relay-body-failure");
  const response = await control.fetch(relayRequest("/facet/relay/body-failure"));

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("partial");
  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "body-failed", responseStatus: 200 },
  ]);
  expect(await control.getRelayFacts()).toMatchObject([
    { kind: "headers-received", responseStatus: 200 },
    { kind: "body-failed", responseStatus: 200 },
  ]);
});

test("records a complete streamed body", async () => {
  const control = await activeSupervisor("relay-complete-body");
  const response = await control.fetch(relayRequest("/facet/relay/body-complete"));

  expect(await response.text()).toBe("complete body");
  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "body-completed", responseStatus: 200 },
  ]);
});

test("treats a completed 5xx response as a failure observation", async () => {
  const control = await activeSupervisor("relay-error-status");
  const response = await control.fetch(relayRequest("/facet/relay/error-status"));

  expect(response.status).toBe(500);
  expect(await response.text()).toBe("failure body");
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "failure-observed" });
});

test("leaves a local caller cancellation pending until a bounded sweep", async () => {
  const control = await activeSupervisor("relay-cancelled");
  const controller = new AbortController();
  const response = await control.fetch(
    relayRequest("/facet/relay/hang", { signal: controller.signal }),
  );

  controller.abort("caller went away");
  await response.body?.cancel("caller went away");

  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "pending", responseStatus: 200 },
  ]);
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "insufficient-credited-turns" });
});

test("bounds a pending relay when an explicit sweep reaches its deadline", async () => {
  const control = await activeSupervisor("relay-bounded-abandonment");
  const response = await control.fetch(relayRequest("/facet/relay/hang"));
  const [pending] = await control.getRelayAttempts();
  if (pending === undefined) {
    throw new Error("a relayed request must create an attempt before its body resolves");
  }

  const swept = await control.sweepExpiredRelayAttempts(pending.deadlineAt);
  await response.body?.cancel("test cleanup");

  expect(swept).toMatchObject([{ outcome: "bounded-abandonment" }]);
  expect(await control.getRelayAttempts()).toMatchObject([
    { outcome: "bounded-abandonment", responseStatus: 200 },
  ]);
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "insufficient-credited-turns" });
});

test("retains an earlier activation's facts without crediting a reactivated generation", async () => {
  const control = await activeSupervisor("relay-superseded-activation");
  const first = await control.fetch(relayRequest("/facet/relay/body-complete"));
  await first.text();
  const firstAttempt = (await control.getRelayAttempts())[0];
  if (firstAttempt === undefined) {
    throw new Error("a completed response must retain its attempt");
  }

  const secondCommit = "0123456789abcdef0123456789abcdef01234567";
  const labeled = await control.labelGeneration(secondCommit);
  if (!labeled.ok) {
    throw new Error("a valid harness commit must receive a generation label");
  }
  await control.recordPreparationCheck(labeled.generation.label, "passed");
  await control.activateGeneration(labeled.generation.label);
  await control.activateGeneration(0);

  expect(await control.getRelayAttempts()).toMatchObject([
    { generationLabel: 0, activationEpoch: firstAttempt.activationEpoch },
  ]);
  expect(
    await control.getGenerationEligibility(0, {
      minimumCreditedTurns: 1,
      minimumObservationSpanMs: 0,
    }),
  ).toMatchObject({ kind: "ineligible", reason: "insufficient-credited-turns" });
});
