import { afterEach, expect, test, vi } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { OwnerApiSupervisor } from "../../src/routes/index.js";
import { textLines } from "../log-capture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { controlRequest, ownerApiSupervisor, ownerScope } from "./helpers.js";

const ORIGIN = "https://cf-stumble.test";

const SECRET = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

const THREAD_PATH = `/api/projects/${sampleProjectOne.id}/thread`;

afterEach(() => {
  vi.restoreAllMocks();
});

function thrown(): Promise<never> {
  return Promise.reject(new Error(`storage failed with ${SECRET} in /root/.git-credentials`));
}

const throwingRoutes: readonly (readonly [string, Request, Partial<OwnerApiSupervisor>])[] = [
  ["GET /api/status", new Request(`${ORIGIN}/api/status`), { getActiveGeneration: thrown }],
  [
    "GET /api/projects/:projectId/thread",
    new Request(`${ORIGIN}${THREAD_PATH}`),
    { getProjectThread: thrown },
  ],
  [
    "POST /api/projects/:projectId/thread/fresh",
    controlRequest(`${THREAD_PATH}/fresh`, "{}"),
    { startFreshProjectThread: thrown },
  ],
  [
    "POST /api/generations/activate",
    controlRequest("/api/generations/activate", '{"observedEpoch":0,"label":0}'),
    { controlGeneration: thrown },
  ],
  [
    "POST /api/generations/rollback",
    controlRequest("/api/generations/rollback", '{"observedEpoch":0,"label":0}'),
    { controlGeneration: thrown },
  ],
  [
    "POST /api/generations/submit",
    controlRequest(
      "/api/generations/submit",
      '{"harnessCommit":"f53a0e1c1bdbe213ab700a84b1db23615cc24b02"}',
    ),
    { controlGeneration: thrown },
  ],
  [
    "POST /api/projects/connect",
    controlRequest(
      "/api/projects/connect",
      JSON.stringify({ repositoryUrl: sampleProjectOne.repositoryUrl }),
    ),
    { connectProject: thrown },
  ],
  [
    "POST /api/github/authorization",
    controlRequest("/api/github/authorization", "{}"),
    { startGitHubAuthorization: thrown },
  ],
  [
    "POST /api/github/authorization/complete",
    controlRequest("/api/github/authorization/complete", "{}"),
    { completeGitHubAuthorization: thrown },
  ],
  [
    "POST /api/projects/:projectId/disconnect",
    controlRequest(`/api/projects/${sampleProjectOne.id}/disconnect`, "{}"),
    { disconnectProject: thrown },
  ],
  [
    "POST /api/workspace/reset",
    controlRequest("/api/workspace/reset", "{}"),
    { resetWorkspace: thrown },
  ],
];

test.each(throwingRoutes)(
  "%s logs a thrown Supervisor error, redacted, and answers a bare fault",
  async (route, request, overrides) => {
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await routeOwnerApiRequest(request, ownerApiSupervisor(overrides), ownerScope);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: { code: "internal-error" } });
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("git-credentials");
    const [logged = "", ...otherLines] = textLines(loggedErrors);
    expect(otherLines).toEqual([]);
    expect(logged).toContain(`owner-api ${route}: internal-error`);
    expect(logged).toContain("storage failed");
    expect(logged).not.toContain(SECRET);
  },
);
