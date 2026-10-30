import { expect, test } from "vitest";
import { parseHarnessCommit } from "../../src/harness-commit.js";
import { parseGenerationLabel } from "../../src/supervisor/generations/index.js";
import { ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

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
  );

  const wrongMethod = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/projects/sample-project-one/thread/fresh"),
    supervisor(),
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
    }),
    supervisor({
      resetWorkspace() {
        calls += 1;

        return Promise.resolve({ ok: true, reset: "workspace" });
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(calls).toBe(1);
  await expect(response.json()).resolves.toEqual({ ok: true, reset: "workspace" });
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
