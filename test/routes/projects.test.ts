import { expect, test } from "vitest";
import { ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";
import { sampleProjectOne } from "../project-fixtures.js";

const ORIGIN = "https://cf-stumble.test";

const connectedProject = sampleProjectOne;

function post(path: string, body: Readonly<Record<string, string>>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("connects the repository the body names, and nothing else it carries", async () => {
  const sent: unknown[] = [];

  const response = await ownerApiResponse(
    post("/api/projects/connect", {
      repositoryUrl: connectedProject.repositoryUrl,
      displayName: "Repo one",
    }),
    supervisor({
      connectProject: (repositoryUrl, displayName) => {
        sent.push(repositoryUrl, displayName);

        return Promise.resolve({
          ok: true,
          alreadyConnected: false,
          project: connectedProject,
          github: { state: "connected", login: "octocat", source: "configured-token" },
          checkedAt: 3_000,
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(sent).toEqual([connectedProject.repositoryUrl, "Repo one"]);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    alreadyConnected: false,
    checkedAt: 3_000,
  });
});

test.each([
  ["invalid-repository-url", 400],
  ["repository-not-accessible", 403],
  ["repository-too-large", 413],
  ["tooling-missing", 503],
  ["provisioning-failed", 503],
] as const)("answers a %s connection with %i", async (code, status) => {
  const response = await ownerApiResponse(
    post("/api/projects/connect", { repositoryUrl: "https://github.com/sample/repo-1" }),
    supervisor({
      connectProject: () =>
        Promise.resolve({
          ok: false,
          problem: { code, detail: "" },
          github: { state: "disconnected" },
          checkedAt: null,
        }),
    }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ ok: false, problem: { code } });
});

test("starts an authorization and answers its status", async () => {
  const response = await ownerApiResponse(
    post("/api/github/authorization", {}),
    supervisor({
      startGitHubAuthorization: () =>
        Promise.resolve({
          ok: true,
          status: {
            state: "awaiting-authorization",
            verificationUri: "https://github.com/login/device",
            userCode: "WDJB-MJHT",
            expiresAt: 1,
          },
          checkedAt: 4_000,
        }),
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    github: {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: 1,
    },
    checkedAt: 4_000,
  });
});

test.each([
  ["no-pending-authorization", 409],
  ["authorization-expired", 410],
  ["authorization-denied", 403],
  ["provider-unavailable", 502],
  ["not-configured", 503],
] as const)("answers the %s authorization outcome with %i", async (problem, status) => {
  const response = await ownerApiResponse(
    post("/api/github/authorization/complete", {}),
    supervisor({ completeGitHubAuthorization: () => Promise.resolve({ ok: false, problem }) }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code: problem } });
});

test("disconnects the project id in the path", async () => {
  let disconnected: unknown;

  const response = await ownerApiResponse(
    post(`/api/projects/${connectedProject.id}/disconnect`, {}),
    supervisor({
      disconnectProject: (projectId) => {
        disconnected = projectId;

        return Promise.resolve({
          ok: true,
          projectId: connectedProject.id,
          workspace: "removed",
        });
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(disconnected).toBe(connectedProject.id);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    projectId: connectedProject.id,
    workspace: "removed",
  });
});

test.each([
  ["invalid-project-id", 400],
  ["unknown-project-id", 404],
  ["run-active", 409],
] as const)("answers a %s disconnect refusal with %i", async (code, status) => {
  const response = await ownerApiResponse(
    post(`/api/projects/${connectedProject.id}/disconnect`, {}),
    supervisor({
      disconnectProject: () => Promise.resolve({ ok: false, problem: { code } }),
    }),
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
});
