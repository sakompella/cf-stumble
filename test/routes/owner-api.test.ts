import { exports as workerExports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import {
  controlRequest,
  ownerApiResponse,
  ownerApiSupervisor as supervisor,
  ownerScope,
} from "./helpers.js";

test("returns the active generation", async () => {
  const response = await ownerApiResponse(
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
    ownerScope,
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
  });
});

test("returns a project's thread", async () => {
  const response = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/projects/sample-project-one/thread"),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    thread: {
      projectId: "sample-project-one",
      conversation: "[]",
      messageCount: 0,
      revision: 0,
      turnActive: false,
    },
  });
});

test("reports a project the catalog does not have without inventing a thread", async () => {
  const response = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/projects/project-nine/thread"),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});

test("starts a fresh thread only on POST, and passes the id the client named", async () => {
  let reset: string | undefined;

  const fresh = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/projects/sample-project-one/thread/fresh", {
      method: "POST",
      headers: { origin: "https://cf-stumble.test" },
    }),
    supervisor({
      startFreshProjectThread(projectId) {
        reset = projectId;

        return Promise.resolve({
          ok: true,
          thread: {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the route never inspects the branded id, and this stands in for the catalog's own value.
            projectId: projectId as never,
            conversation: "[]",
            messageCount: 0,
            revision: 0,
            turnActive: false,
            turnDeadlineAt: undefined,
          },
        });
      },
    }),
    ownerScope,
  );

  const wrongMethod = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/projects/sample-project-one/thread/fresh"),
    supervisor(),
    ownerScope,
  );

  expect(reset).toBe("sample-project-one");
  expect(fresh.status).toBe(200);
  expect(wrongMethod.status).toBe(404);
});

test("resets the workspace and reports what it reset", async () => {
  let calls = 0;

  const response = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/workspace/reset", {
      method: "POST",
      headers: { origin: "https://cf-stumble.test" },
    }),
    supervisor({
      resetWorkspace() {
        calls += 1;

        return Promise.resolve({ ok: true, reset: "workspace" });
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(calls).toBe(1);
  await expect(response.json()).resolves.toEqual({ ok: true, reset: "workspace" });
});

test("an unauthenticated project disconnect cannot reach the owner API", async () => {
  const response = await workerExports.default.fetch(
    new Request("https://cf-stumble.test/api/projects/sample-project-one/disconnect", {
      method: "POST",
    }),
  );

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
});

test("an unauthenticated workspace reset cannot reach the owner API", async () => {
  const response = await workerExports.default.fetch(
    new Request("https://cf-stumble.test/api/workspace/reset", { method: "POST" }),
  );

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
});

test("returns JSON 404 for unknown route and method pairs", async () => {
  const unknownPath = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/unknown"),
    supervisor(),
    ownerScope,
  );

  const unknownMethod = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/status", {
      method: "POST",
      headers: { origin: "https://cf-stumble.test" },
    }),
    supervisor(),
    ownerScope,
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
  const response = await workerExports.default.fetch(
    new Request("https://cf-stumble.test/api/status"),
  );

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
});

test("an unauthenticated request cannot reach a generation control route", async () => {
  const activate = controlRequest(
    "/api/generations/activate",
    JSON.stringify({ observedEpoch: 0, label: 0 }),
  );

  const rollback = controlRequest(
    "/api/generations/rollback",
    JSON.stringify({ observedEpoch: 0, label: 0 }),
  );

  const submit = controlRequest(
    "/api/generations/submit",
    JSON.stringify({
      harnessCommit: "f53a0e1c1bdbe213ab700a84b1db23615cc24b02",
    }),
  );

  const activateResponse = await workerExports.default.fetch(activate);
  const rollbackResponse = await workerExports.default.fetch(rollback);
  const submitResponse = await workerExports.default.fetch(submit);

  expect([activateResponse.status, rollbackResponse.status, submitResponse.status]).toEqual([
    401, 401, 401,
  ]);
});

test("keeps the generation control routes POST-only", async () => {
  const getActivate = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/activate"),
    supervisor(),
    ownerScope,
  );

  const getSubmit = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/generations/submit"),
    supervisor(),
    ownerScope,
  );

  expect(getActivate.status).toBe(404);
  expect(getSubmit.status).toBe(404);
});

test("refuses a cross-origin POST before it looks for a route", async () => {
  const response = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/unknown", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "cross-origin-request" },
  });
});
