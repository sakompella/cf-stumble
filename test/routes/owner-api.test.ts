/// <reference types="@cloudflare/vitest-plugin/types" />

import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import { controlRequest, ownerApiSupervisor as supervisor } from "./helpers.js";

test("returns the active generation and no recovery report when none exists", async () => {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/status"),
    supervisor({
      getActiveGeneration() {
        const label = parseGenerationLabel(0);
        const harnessCommit = parseHarnessCommit("f53a0e1c1bdbe213ab700a84b1db23615cc24b02");
        if (label === undefined || harnessCommit === undefined) {
          throw new Error("test fixture must contain valid generation values");
        }
        return Promise.resolve({
          generation: { label, harnessCommit, status: "ready" },
          epoch: 2,
          activationId: 1,
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  await expect(response.json()).resolves.toEqual({
    activeGeneration: {
      generation: {
        label: 0,
        harnessCommit: "f53a0e1c1bdbe213ab700a84b1db23615cc24b02",
        status: "ready",
      },
      epoch: 2,
      activationId: 1,
    },
    latestRecoveryReport: null,
  });
});

test("returns a saved session record", async () => {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/sessions/session-a"),
    supervisor({
      getSession(sessionId) {
        return Promise.resolve({
          sessionId,
          document: '{"turns":["first"]}',
          revision: 1,
          turnActive: false,
          turnDeadlineAt: undefined,
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    session: {
      sessionId: "session-a",
      document: '{"turns":["first"]}',
      revision: 1,
      turnActive: false,
    },
  });
});

test("returns a JSON not-found result for a missing session", async () => {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/sessions/missing"),
    supervisor(),
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "session-not-found" },
  });
});

test("returns the Supervisor turn result without changing a stale revision conflict", async () => {
  let called: readonly [string, string, number] | undefined;
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/sessions/session-a/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "stale", expectedRevision: 0 }),
    }),
    supervisor({
      runSessionTurn(sessionId, prompt, expectedRevision) {
        called = [sessionId, prompt, expectedRevision];
        return Promise.resolve({
          ok: false,
          problem: { code: "stale-revision", sessionId, currentRevision: 1 },
        });
      },
    }),
  );

  expect(called).toEqual(["session-a", "stale", 0]);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "stale-revision", sessionId: "session-a", currentRevision: 1 },
  });
});

test("returns JSON 400 without invoking a turn for a malformed body", async () => {
  let invoked = false;
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/sessions/session-a/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":',
    }),
    supervisor({
      runSessionTurn() {
        invoked = true;
        return Promise.resolve({
          ok: true,
          response: { text: "unexpected", commands: [], sessionRevision: 1 },
        });
      },
    }),
  );

  expect(invoked).toBe(false);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "invalid-turn-request" },
  });
});

test("returns JSON 404 for unknown route and method pairs", async () => {
  const unknownPath = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/unknown"),
    supervisor(),
  );
  const unknownMethod = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/status", { method: "POST" }),
    supervisor(),
  );

  expect(unknownPath.status).toBe(404);
  await expect(unknownPath.json()).resolves.toEqual({ ok: false, error: { code: "not-found" } });
  expect(unknownMethod.status).toBe(404);
  await expect(unknownMethod.json()).resolves.toEqual({
    ok: false,
    error: { code: "not-found" },
  });
});

test("an unauthenticated request cannot reach an owner API route", async () => {
  // oxlint-disable-next-line typescript/no-deprecated
  const response = await SELF.fetch(new Request("https://cf-stumble.test/api/status"));

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
});

test("an unauthenticated request cannot reach a generation control route", async () => {
  const activate = controlRequest(
    "/api/generations/activate",
    JSON.stringify({ requestId: "unauthenticated", observedEpoch: 0, label: 0 }),
  );
  const rollback = controlRequest(
    "/api/generations/rollback",
    JSON.stringify({ requestId: "unauthenticated", observedEpoch: 0, label: 0 }),
  );
  const submit = controlRequest(
    "/api/generations/submit",
    JSON.stringify({
      requestId: "unauthenticated",
      harnessCommit: "f53a0e1c1bdbe213ab700a84b1db23615cc24b02",
    }),
  );

  // oxlint-disable-next-line typescript/no-deprecated
  const activateResponse = await SELF.fetch(activate);
  // oxlint-disable-next-line typescript/no-deprecated
  const rollbackResponse = await SELF.fetch(rollback);
  // oxlint-disable-next-line typescript/no-deprecated
  const submitResponse = await SELF.fetch(submit);
  // oxlint-disable-next-line typescript/no-deprecated
  const recoveryResponse = await SELF.fetch(
    new Request("https://cf-stumble.test/api/recovery/latest"),
  );

  expect([
    activateResponse.status,
    rollbackResponse.status,
    submitResponse.status,
    recoveryResponse.status,
  ]).toEqual([401, 401, 401, 401]);
});
test("reports no recovery report before any recovery episode exists", async () => {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/recovery/latest"),
    supervisor(),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, report: null });
});

test("keeps a GET-only recovery route and a POST-only control route", async () => {
  const postRecovery = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/recovery/latest", { method: "POST" }),
    supervisor(),
  );
  const getActivate = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/generations/activate"),
    supervisor(),
  );
  const getSubmit = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/generations/submit"),
    supervisor(),
  );

  expect(postRecovery.status).toBe(404);
  expect(getActivate.status).toBe(404);
  expect(getSubmit.status).toBe(404);
});
