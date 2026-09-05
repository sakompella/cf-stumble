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

test("returns a project's thread", async () => {
  const response = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/projects/project-one/thread"),
    supervisor(),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    thread: {
      projectId: "project-one",
      conversation: "[]",
      messageCount: 0,
      revision: 0,
      turnActive: false,
    },
  });
});

test("reports a project the catalog does not have without inventing a thread", async () => {
  const response = await routeOwnerApiRequest(
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
  const fresh = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/projects/project-one/thread/fresh", {
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
  const wrongMethod = await routeOwnerApiRequest(
    new Request("https://cf-stumble.test/api/projects/project-one/thread/fresh"),
    supervisor(),
  );

  expect(reset).toBe("project-one");
  expect(fresh.status).toBe(200);
  expect(wrongMethod.status).toBe(404);
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
