/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { containsCredential } from "../../src/github/index.js";
import { forwardToFacet, type Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  activeSupervisor,
  artifact,
  prepareWithModuleMap,
  submitCandidate,
} from "./helpers.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function servingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("candidate serving body"); }
}
`,
  );
}

function failingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("candidate failed", { status: 500 }); }
}
`,
  );
}

function relayRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://cf-stumble.test${path}`, init);
}

async function activateServingCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<void> {
  const candidate = await submitCandidate(control, harnessCommit);
  const startup = await prepareWithModuleMap(control, candidate, servingArtifact(harnessCommit));

  if (!startup.ok || startup.report.stage !== "ready") {
    throw new Error("the candidate must pass startup before activation");
  }

  await activateGeneration(control, candidate);
}

afterEach(async () => {
  await reset();
});

/**
 * The Supervisor once seeded Generation 0 from the fixture commit and served the fixture module
 * map whenever no generation was active, so `/facet/ping` answered `pong` on a Supervisor that had
 * never been given code. Nothing is built in now: with no active generation there is nothing to
 * serve.
 */
test("reports a typed failure and serves nothing when no generation is active", async () => {
  const control = supervisor("no-active-generation-serves-nothing");

  const response = await control.fetch(new Request("https://cf-stumble.test/facet/ping"));

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "no-active-generation" },
  });
  expect(await control.getGenerations(), "no submission means no labeled generation").toEqual([]);
});

test("serves the activated generation's retained artifact", async () => {
  const control = await activeSupervisor("serves-active-generation");
  await activateServingCandidate(control, "0123456789abcdef0123456789abcdef01234567");

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("serves the active retained artifact after Durable Object eviction", async () => {
  const control = await activeSupervisor("serves-active-generation-after-eviction");
  await activateServingCandidate(control, "d123456789abcdef0123456789abcdef01234567");
  await evictDurableObject(control);

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(await response.text()).toBe("candidate serving body");
});

test("keeps the active retained artifact when a failed candidate cannot activate", async () => {
  const control = await activeSupervisor("failed-candidate-keeps-active-artifact");
  await activateServingCandidate(control, "e123456789abcdef0123456789abcdef01234567");

  const failedCandidate = await submitCandidate(
    control,
    "f123456789abcdef0123456789abcdef01234567",
  );

  const failedStartup = await prepareWithModuleMap(
    control,
    failedCandidate,
    failingArtifact("f123456789abcdef0123456789abcdef01234567"),
  );

  if (!failedStartup.ok || failedStartup.report.stage !== "response-rejected") {
    throw new Error("the candidate must fail its startup check");
  }

  const active = await control.getActiveGeneration();

  const activation = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "activate", label: failedCandidate, observedEpoch: active.epoch },
  });

  const response = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(activation).toEqual({ ok: false, problem: { code: "not-ready" } });
  expect(await response.text()).toBe("candidate serving body");
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
});

/**
 * The public 502 tells a caller nothing, on purpose: a broken generation and a Loader or RPC
 * transport failure must look identical to the caller. An operator still needs to tell them
 * apart, so the discarded cause must reach a log, redacted, without changing the response at all.
 */
test("logs the discarded cause of a pre-header failure without changing the public 502", async () => {
  const control = await activeSupervisor("relay-pre-header-failure");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await control.fetch(relayRequest("/facet/relay/pre-header-failure"));

  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Main facet failed before response headers");
  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("facet failed before headers");

  loggedErrors.mockRestore();
});

test("redacts a token-shaped pre-header failure cause", async () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  const token = `ghp_${"a".repeat(36)}`;

  const response = await forwardToFacet(relayRequest("/facet/relay/pre-header-failure"), {
    fetch: () => {
      throw new Error(`facet failed before headers: ${token}`);
    },
  });

  expect(response.status).toBe(502);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("main-facet-failed-before-headers");
  expect(containsCredential(logged), "the operator log must redact token-shaped causes").toBe(
    false,
  );
});
