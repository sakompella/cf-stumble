import * as Effect from "effect/Effect";
import { routeOwnerApiRequest, type OwnerApiSupervisor } from "../../src/routes/index.js";
import type { ConversationApiSupervisor } from "../../src/routes/conversations.js";
import type { ChatGPTConnectionView } from "../../src/chatgpt/index.js";

/** The owner API's answer to one request, run as the Worker's entry point runs it. */
export function ownerApiResponse(
  request: Request,
  supervisor: OwnerApiSupervisor,
): Promise<Response> {
  return Effect.runPromise(routeOwnerApiRequest(request, supervisor));
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
      return Promise.resolve({ generation: undefined, epoch: 0 });
    },
    submitProjectMessage: notCalled("submit a message"),
    projectEvents: notCalled("watch a conversation"),
    abortProjectRun: notCalled("abort a run"),
    freshProjectConversation: notCalled("start a fresh thread"),
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

/** Refuses every message as `workspace-busy` (409), so a test can tell a refusal from a bad body (400). */
export function messageRefusingSupervisor(
  onMessage: () => void = () => {},
): ConversationApiSupervisor {
  return ownerApiSupervisor({
    submitProjectMessage: () => {
      onMessage();

      return Promise.resolve({ ok: false, problem: { code: "workspace-busy" } });
    },
  });
}

/** The body stays raw text so a malformed request reaches the route exactly as it was sent. */
export function controlRequest(path: string, body: string): Request {
  return new Request(`https://cf-stumble.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
