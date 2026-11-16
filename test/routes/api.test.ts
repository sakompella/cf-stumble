import { expect, test } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label } from "../supervisor/generations/fixtures.js";
import { apiResponse, apiSupervisor as supervisor } from "./helpers.js";

test("returns the active generation and how far main is ahead of it", async () => {
  const response = await apiResponse(
    new Request("https://cf-stumble.test/api/status"),
    supervisor({
      getStatus() {
        const harnessCommit = testHarnessCommit("f53a0e1c1bdbe213ab700a84b1db23615cc24b02");

        return Promise.resolve({
          activeGeneration: {
            generation: { label: label(0), harnessCommit, status: "ready" },
            epoch: 2,
          },
          mainAhead: 3,
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
    },
    mainAhead: 3,
  });
});

const PROJECT = "https://cf-stumble.test/api/projects/sample-project-one";

test("accepts a message with 202 and passes the project the client named", async () => {
  let named: unknown;

  const response = await apiResponse(
    new Request(`${PROJECT}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello", requestId: "r1" }),
    }),
    supervisor({
      submitProjectMessage(projectId) {
        named = projectId;

        return Promise.resolve({ ok: true, submissionId: 1 });
      },
    }),
  );

  expect(named).toBe("sample-project-one");
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual({ ok: true, submissionId: 1 });
});

test("streams a conversation's events as JSON lines", async () => {
  const response = await apiResponse(
    new Request(`${PROJECT}/events`),
    supervisor({
      projectEvents: () =>
        Promise.resolve({
          ok: true,
          events: new Response('[["r",{}]]\n').body ?? new ReadableStream(),
        }),
    }),
  );

  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  await expect(response.text()).resolves.toBe('[["r",{}]]\n');
});

test.each([
  ["unknown-project-id", 404],
  ["invalid-message", 400],
  ["no-active-generation", 503],
  ["generation-failed", 503],
] as const)("answers a %s refusal with %i", async (code, status) => {
  const response = await apiResponse(
    new Request(`${PROJECT}/abort`, { method: "POST" }),
    supervisor({ abortProjectRun: () => Promise.resolve({ ok: false, problem: { code } }) }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
});

test("a fresh thread answers the conversation the Supervisor started", async () => {
  const response = await apiResponse(
    new Request(`${PROJECT}/thread/fresh`, { method: "POST" }),
    supervisor({
      freshProjectConversation: () => Promise.resolve({ ok: true, conversationId: "c2" }),
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, conversationId: "c2" });
});

test.each([
  ["run-active", 409],
  ["workspace-busy", 409],
  ["workspace-unavailable", 503],
] as const)("a workspace reset refused with %s answers %i", async (code, status) => {
  const response = await apiResponse(
    new Request("https://cf-stumble.test/api/workspace/reset", { method: "POST" }),
    supervisor({
      resetWorkspace: () => Promise.resolve({ ok: false, problem: { code } }),
    }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
});
