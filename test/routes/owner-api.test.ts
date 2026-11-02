import { expect, test } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label } from "../supervisor/generations/fixtures.js";
import { ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

test("returns the active generation", async () => {
  const response = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/status"),
    supervisor({
      getActiveGeneration() {
        const harnessCommit = testHarnessCommit("f53a0e1c1bdbe213ab700a84b1db23615cc24b02");

        return Promise.resolve({
          generation: { label: label(0), harnessCommit, status: "ready" },
          epoch: 2,
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
  });
});

const PROJECT = "https://cf-stumble.test/api/projects/sample-project-one";

test("accepts a message with 202 and passes the project the client named", async () => {
  let named: unknown;

  const response = await ownerApiResponse(
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
  const response = await ownerApiResponse(
    new Request(`${PROJECT}/events`),
    supervisor({
      projectEvents: () =>
        Promise.resolve({
          ok: true,
          events: new Response('{"type":"snapshot"}\n').body ?? new ReadableStream(),
        }),
    }),
  );

  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  await expect(response.text()).resolves.toBe('{"type":"snapshot"}\n');
});

test.each([
  ["unknown-project-id", 404],
  ["invalid-message", 400],
  ["no-active-generation", 503],
  ["generation-failed", 503],
] as const)("answers a %s refusal with %i", async (code, status) => {
  const response = await ownerApiResponse(
    new Request(`${PROJECT}/abort`, { method: "POST" }),
    supervisor({ abortProjectRun: () => Promise.resolve({ ok: false, problem: { code } }) }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
});

test("starts a fresh thread only on POST", async () => {
  const fresh = await ownerApiResponse(
    new Request(`${PROJECT}/thread/fresh`, { method: "POST" }),
    supervisor({
      freshProjectConversation: () => Promise.resolve({ ok: true, conversationId: "c2" }),
    }),
  );

  const wrongMethod = await ownerApiResponse(new Request(`${PROJECT}/thread/fresh`), supervisor());

  await expect(fresh.json()).resolves.toEqual({ ok: true, conversationId: "c2" });
  expect(wrongMethod.status).toBe(404);
});

test("returns JSON 404 for unknown route and method pairs", async () => {
  const unknownPath = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/unknown"),
    supervisor(),
  );

  const unknownMethod = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/status", {
      method: "POST",
    }),
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

test("keeps the generation control routes POST-only", async () => {
  const getActivate = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/activate"),
    supervisor(),
  );

  const getSubmit = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/submit"),
    supervisor(),
  );

  expect(getActivate.status).toBe(404);
  expect(getSubmit.status).toBe(404);
});
