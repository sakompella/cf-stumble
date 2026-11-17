import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { ApiSupervisor } from "../../src/routes/api.js";
import { routePattern } from "../../src/routes/route-pattern.js";
import { apiResponse } from "./helpers.js";

const ROUTES: readonly (readonly [method: string, path: string])[] = [
  ["GET", "/api/status"],
  ["GET", "/api/projects"],
  ["GET", "/api/github/connection"],
  ["GET", "/api/chatgpt/connection"],
  ["GET", "/api/workspace/backend"],
  ["POST", "/api/workspace/backend"],
  ["POST", "/api/workspace/reset"],
  ["POST", "/api/projects/connect"],
  ["POST", "/api/github/connection/refresh"],
  ["POST", "/api/github/authorization"],
  ["POST", "/api/github/authorization/complete"],
  ["POST", "/api/chatgpt/login"],
  ["POST", "/api/chatgpt/login/complete"],
  ["POST", "/api/chatgpt/disconnect"],
  ["POST", "/api/generations/submit"],
  ["POST", "/api/generations/activate"],
  ["POST", "/api/generations/rollback"],
  ["POST", "/api/projects/:projectId/messages"],
  ["GET", "/api/projects/:projectId/events"],
  ["GET", "/api/projects/:projectId/entries"],
  ["POST", "/api/projects/:projectId/abort"],
  ["POST", "/api/projects/:projectId/thread/fresh"],
  ["POST", "/api/projects/:projectId/disconnect"],
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function reachingSupervisor(onReach: () => void): ApiSupervisor {
  const reach = () => {
    onReach();

    return Promise.reject(new Error("the property stops at the Supervisor"));
  };

  return {
    getStatus: reach,
    submitProjectMessage: reach,
    projectEvents: reach,
    projectEntries: reach,
    abortProjectRun: reach,
    freshProjectConversation: reach,
    controlGeneration: reach,
    submitGeneration: reach,
    prepareGeneration: reach,
    scriptVersion: reach,
    listProjects: reach,
    connectProject: reach,
    getGitHubConnection: reach,
    refreshGitHubConnection: reach,
    startGitHubAuthorization: reach,
    completeGitHubAuthorization: reach,
    disconnectProject: reach,
    resetWorkspace: reach,
    getWorkspaceBackend: reach,
    setWorkspaceBackend: reach,
    getChatGPTConnection: reach,
    startChatGPTLogin: reach,
    completeChatGPTLogin: reach,
    disconnectChatGPT: reach,
  };
}

const projectId = gs.fromRegex("[a-z0-9]{1,8}(-[a-z0-9]{1,8}){0,2}");

const strayEnding = gs.sampledFrom(["", "/x", "/", "/rename"]);

const strayApiPath = gs.fromRegex("/api/[a-z]{2,8}-[a-z]{2,8}");

test("a request answers not-found without reaching the Supervisor exactly when no API route has its method and path, and logs under its route's pattern", async () => {
  await hegel.testAsync(async (tc) => {
    const method = tc.draw(gs.sampledFrom(METHODS));

    let path = tc.draw(strayApiPath);

    let known = false;

    let pattern = "/api/unknown";

    if (tc.draw(gs.booleans())) {
      const [, template] = tc.draw(gs.sampledFrom(ROUTES));
      const ending = tc.draw(strayEnding);

      path = `${template.replace(":projectId", tc.draw(projectId))}${ending}`;
      known = ending === "" && ROUTES.some((route) => route[0] === method && route[1] === template);
      pattern = ending === "" ? template : pattern;
    }

    expect(routePattern(path)).toBe(pattern);

    let reached = false;

    const response = await apiResponse(
      new Request(`https://cf-stumble.test${path}`, { method }),
      reachingSupervisor(() => {
        reached = true;
      }),
    );

    if (known) {
      expect(response.status).not.toBe(404);

      return;
    }

    expect([response.status, await response.json(), reached]).toEqual([
      404,
      { ok: false, error: { code: "not-found" } },
      false,
    ]);
  });
});
