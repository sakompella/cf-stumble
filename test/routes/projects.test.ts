import { afterEach, expect, test, vi } from "vitest";
import { ownerApiResponse, ownerApiSupervisor as supervisor, ownerScope } from "./helpers.js";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
      displayName?: string | number | null;
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

test("lists the tenant's projects", async () => {
  const response = await ownerApiResponse(
    get("/api/projects"),
    supervisor({
      listProjects: () => Promise.resolve([{ kind: "repository", ...connectedProject }]),
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    projects: [{ kind: "repository", ...connectedProject }],
  });
});

const CONNECTED = { state: "connected", login: "octocat", source: "device-authorization" } as const;

test("answers the recorded connection with the time the workspace was last checked", async () => {
  const response = await ownerApiResponse(
    get("/api/github/connection"),
    supervisor({
      getGitHubConnection: () => Promise.resolve({ github: CONNECTED, checkedAt: 1_000 }),
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ ok: true, github: CONNECTED, checkedAt: 1_000 });
  expect(body).not.toContain(FAKE_TOKEN);
});

test("refreshes the connection on a POST from the page, with the route's request id", async () => {
  const received: (string | undefined)[] = [];

  const response = await ownerApiResponse(
    post("/api/github/connection/refresh", {}),
    supervisor({
      refreshGitHubConnection: (requestId) => {
        received.push(requestId);

        return Promise.resolve({ github: CONNECTED, checkedAt: 2_000 });
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    github: CONNECTED,
    checkedAt: 2_000,
  });
  expect(received).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u)]);
});

test.each([
  ["rejects", new Error("workspace RPC is unavailable")],
  ["times out", new DOMException("workspace RPC timed out", "TimeoutError")],
] as const)("maps a connection refresh whose Supervisor RPC %s to 503", async (_kind, cause) => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const response = await ownerApiResponse(
    post("/api/github/connection/refresh", {}),
    supervisor({ refreshGitHubConnection: () => Promise.reject(cause) }),
    ownerScope,
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "internal-error" },
  });
  expect(loggedErrors).toHaveBeenCalledWith(
    expect.stringContaining("routes.projects.connection: workspace-unavailable"),
  );
  expect(loggedErrors.mock.calls.join(" ")).toContain(cause.message);
});

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
    ownerScope,
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
  [{ repositoryUrl: 7 }],
  [{ displayName: "no url" }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", displayName: 7 }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", displayName: null }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", tenant: "someone-else" }],
  [{ repositoryUrl: "https://github.com/sample/repo-1", token: FAKE_TOKEN }],
  ["not an object"],
])("refuses the connect body %j before it reaches the Supervisor", async (body) => {
  const response = await ownerApiResponse(
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
    ownerScope,
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ ok: false, problem: { code } });
});

test("starts an authorization for the verified owner, not for one the body names", async () => {
  const scopes: VerifiedAccessScope[] = [];

  const response = await ownerApiResponse(
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
          checkedAt: 4_000,
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
    checkedAt: 4_000,
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
  const response = await ownerApiResponse(
    post("/api/github/authorization/complete", {}),
    supervisor({ completeGitHubAuthorization: () => Promise.resolve({ ok: false, problem }) }),
    ownerScope,
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
    ownerScope,
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
  ["harness-project", 400],
  ["turn-active", 409],
] as const)("answers a %s disconnect refusal with %i", async (code, status) => {
  const response = await ownerApiResponse(
    post(`/api/projects/${connectedProject.id}/disconnect`, {}),
    supervisor({
      disconnectProject: () => Promise.resolve({ ok: false, problem: { code } }),
    }),
    ownerScope,
  );

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
});

test("keeps disconnect POST-only", async () => {
  const response = await ownerApiResponse(
    get(`/api/projects/${connectedProject.id}/disconnect`),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(404);
});

test("keeps the project routes to their methods", async () => {
  const postList = await ownerApiResponse(post("/api/projects", {}), supervisor(), ownerScope);

  const getConnect = await ownerApiResponse(get("/api/projects/connect"), supervisor(), ownerScope);

  const getRefresh = await ownerApiResponse(
    get("/api/github/connection/refresh"),
    supervisor(),
    ownerScope,
  );

  expect([postList.status, getConnect.status, getRefresh.status]).toEqual([404, 404, 404]);
});
