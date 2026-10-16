import * as Effect from "effect/Effect";
import { routeOwnerApiRequest, type OwnerApiSupervisor } from "../../src/routes/index.js";
import {
  emptyThread,
  serializedThread,
  type ProjectThreadResult,
} from "../../src/supervisor/threads/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import type { VerifiedAccessScope } from "../../src/supervisor/projects/index.js";
import type { ChatGPTConnectionView } from "../../src/chatgpt/index.js";

/**
 * The verified scope the Worker hands the owner API. Boundary tests pass it explicitly, because
 * the routes take the tenant from the boundary and never from request data.
 */
export const ownerScope: VerifiedAccessScope = {
  identity: "owner-subject",
  audience: "owner-api-audience",
};

/** The owner API's answer to one request, run as the Worker's entry point runs it. */
export function ownerApiResponse(
  request: Request,
  supervisor: OwnerApiSupervisor,
  scope: VerifiedAccessScope,
): Promise<Response> {
  return Effect.runPromise(routeOwnerApiRequest(request, supervisor, scope));
}

export const disconnectedChatGPT: ChatGPTConnectionView = {
  connection: { state: "disconnected" },
  login: null,
  model: "gpt-test",
};

const notCalled = (what: string) => () => Promise.reject(new Error(`this test must not ${what}`));

const chatgptSupervisor: Pick<
  OwnerApiSupervisor,
  "getChatGPTConnection" | "startChatGPTLogin" | "completeChatGPTLogin" | "disconnectChatGPT"
> = {
  getChatGPTConnection: () => Promise.resolve(disconnectedChatGPT),
  startChatGPTLogin: notCalled("start a ChatGPT sign-in"),
  completeChatGPTLogin: notCalled("complete a ChatGPT sign-in"),
  disconnectChatGPT: notCalled("disconnect ChatGPT"),
};

/** A stand-in Supervisor for boundary tests. Each test overrides only the call it exercises. */
export function ownerApiSupervisor(
  overrides: Partial<OwnerApiSupervisor> = {},
): OwnerApiSupervisor {
  return {
    getActiveGeneration() {
      return Promise.resolve({ generation: undefined, epoch: 0, activationId: undefined });
    },
    getProjectThread(projectId) {
      return Promise.resolve(unknownProjectOr(projectId));
    },
    startFreshProjectThread(projectId) {
      return Promise.resolve(unknownProjectOr(projectId));
    },
    runProjectTurn() {
      return Promise.reject(new Error("this test must not run a project turn"));
    },
    controlGeneration() {
      return Promise.reject(new Error("this test must not reach generation control"));
    },
    prepareGeneration() {
      return Promise.reject(new Error("this test must not reach generation preparation"));
    },
    listProjects() {
      return Promise.resolve([]);
    },
    connectProject() {
      return Promise.reject(new Error("this test must not connect a repository"));
    },
    getGitHubConnection() {
      return Promise.resolve({ github: null, checkedAt: null });
    },
    refreshGitHubConnection: notCalled("check the workspace's GitHub credential"),
    startGitHubAuthorization() {
      return Promise.reject(new Error("this test must not start a GitHub authorization"));
    },
    completeGitHubAuthorization() {
      return Promise.reject(new Error("this test must not complete a GitHub authorization"));
    },
    disconnectProject() {
      return Promise.reject(new Error("this test must not disconnect a project"));
    },
    resetWorkspace() {
      return Promise.resolve({ ok: true, reset: "workspace" });
    },
    ...chatgptSupervisor,
    ...overrides,
  };
}

/** Stands in for the catalog: the first catalog project has a thread, and nothing else does. */
function unknownProjectOr(projectId: string): ProjectThreadResult {
  const firstProject = sampleProjectOne;

  return projectId === firstProject.id
    ? { ok: true, thread: serializedThread(emptyThread(firstProject.id)) }
    : { ok: false, problem: { code: "unknown-project-id" } };
}

/** The body stays raw text so a malformed request reaches the route exactly as it was sent. */
export function controlRequest(path: string, body: string): Request {
  return new Request(`https://cf-stumble.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cf-stumble.test" },
    body,
  });
}
