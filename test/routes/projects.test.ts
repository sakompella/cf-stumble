import { expect, test } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { ownerApiSupervisor as supervisor, ownerScope } from "./helpers.js";
import { sampleProjectOne } from "../project-fixtures.js";
import type { VerifiedAccessScope } from "../../src/access/index.js";

/**
 * The project and authorization routes at the HTTP boundary.
 *
 * The Worker verifies Access and derives the Supervisor before any of this runs, so what is left
 * to hold here is narrow and important: a body cannot name an owner, a state-changing request has
 * to come from cf-stumble's own page, and nothing a route returns carries a credential.
 */

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
const ORIGIN = "https://cf-stumble.test";

/** One connected project, as the Supervisor would hand it to a route. */
const connectedProject = sampleProjectOne;

function get(path: string): Request {
  return new Request(`${ORIGIN}${path}`);
}

/**
 * A request body as a test writes it. The fields are the ones a client could send, valid or not,
 * because half of what these tests prove is which bodies the boundary refuses.
 */
type RequestBody =
  | Readonly<{
      repositoryUrl?: string | number;
      displayName?: string;
      tenant?: string;
      identity?: string;
      token?: string;
    }>
  | string;

function post(path: string, body: RequestBody, origin: string | undefined = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: origin === undefined ? {} : { origin },
    body: JSON.stringify(body),
  });
}

test("lists the tenant's projects and its connection status", async () => {
  const response = await routeOwnerApiRequest(
    get("/api/projects"),
    supervisor({
      listProjects: () =>
        Promise.resolve({
          projects: [{ ...connectedProject, connectedAt: 1 }],
          github: { state: "connected", login: "octocat", source: "device-authorization" },
        }),
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    ok: true,
    projects: [{ ...connectedProject, connectedAt: 1 }],
    github: { state: "connected", login: "octocat", source: "device-authorization" },
  });
  expect(body).not.toContain(FAKE_TOKEN);
});

test("connects the repository the body names, and nothing else it carries", async () => {
  const sent: unknown[] = [];
  const response = await routeOwnerApiRequest(
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
        });
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(sent).toEqual([connectedProject.repositoryUrl, "Repo one"]);
  await expect(response.json()).resolves.toMatchObject({ ok: true, alreadyConnected: false });
});

test.each([
  [{ repositoryUrl: 7 }],
  [{ displayName: "no url" }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", tenant: "someone-else" }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", token: FAKE_TOKEN }],
  ["not an object"],
])("refuses the connect body %j before it reaches the Supervisor", async (body) => {
  const response = await routeOwnerApiRequest(
    post("/api/projects/connect", body),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "invalid-connect-request" },
  });
});

test.each([
  ["invalid-repository-url", 400],
  ["project-id-conflict", 409],
  ["repository-not-accessible", 403],
  ["tooling-missing", 503],
  ["provisioning-failed", 503],
] as const)("answers a %s connection with %i", async (code, status) => {
  const response = await routeOwnerApiRequest(
    post("/api/projects/connect", { repositoryUrl: "https://github.com/sample/repo-1" }),
    supervisor({
      connectProject: () =>
        Promise.resolve({
          ok: false,
          problem: { code, detail: "" },
          github: { state: "disconnected" },
        }),
    }),
    ownerScope,
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ ok: false, problem: { code } });
});

test("starts an authorization for the verified owner, not for one the body names", async () => {
  const scopes: VerifiedAccessScope[] = [];
  const response = await routeOwnerApiRequest(
    post("/api/github/authorization", { identity: "someone-else" }),
    supervisor({
      startGitHubAuthorization: (scope) => {
        scopes.push(scope);
        return Promise.resolve({
          ok: true,
          status: {
            state: "awaiting-authorization",
            verificationUri: "https://github.com/login/device",
            userCode: "WDJB-MJHT",
            expiresAt: 1,
            intervalSeconds: 5,
          },
        });
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(scopes).toEqual([ownerScope]);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    github: {
      state: "awaiting-authorization",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      expiresAt: 1,
      intervalSeconds: 5,
    },
  });
});

test.each([
  ["not-the-initiating-owner", 403],
  ["no-pending-authorization", 409],
  ["authorization-expired", 410],
  ["authorization-denied", 403],
  ["provider-unavailable", 502],
  ["not-configured", 503],
] as const)("answers the %s authorization outcome with %i", async (problem, status) => {
  const response = await routeOwnerApiRequest(
    post("/api/github/authorization/complete", {}),
    supervisor({ completeGitHubAuthorization: () => Promise.resolve({ ok: false, problem }) }),
    ownerScope,
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code: problem } });
});

test("refuses a state-changing request from another site before the Supervisor sees it", async () => {
  const paths = [
    "/api/projects/connect",
    "/api/github/authorization",
    "/api/github/authorization/complete",
  ];

  for (const path of paths) {
    const response = await routeOwnerApiRequest(
      post(path, { repositoryUrl: "https://github.com/sample/repo-1" }, "https://evil.test"),
      supervisor(),
      ownerScope,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "cross-origin-request" },
    });
  }
});

test("keeps the project routes to their methods", async () => {
  const postList = await routeOwnerApiRequest(post("/api/projects", {}), supervisor(), ownerScope);
  const getConnect = await routeOwnerApiRequest(
    get("/api/projects/connect"),
    supervisor(),
    ownerScope,
  );

  expect([postList.status, getConnect.status]).toEqual([404, 404]);
});
