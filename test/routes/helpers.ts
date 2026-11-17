import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ANSWERS, type AnswerOf, type AnsweredEndpoint } from "../../src/api/answers.js";
import { routeApiRequest } from "../../src/routes/index.js";
import type { ApiSupervisor } from "../../src/routes/api.js";
import type { ChatGPTConnectionView } from "../../src/chatgpt/index.js";

export const WORKER_VERSION = "version-of-the-request";

export function apiResponse(
  request: Request,
  ...stubs: readonly ApiSupervisor[]
): Promise<Response> {
  const remaining = [...stubs];

  return Effect.runPromise(
    routeApiRequest(request, {
      version: WORKER_VERSION,
      stub: () => {
        const stub = remaining.length > 1 ? remaining.shift() : remaining[0];

        if (stub === undefined) throw new Error("a route test needs a Supervisor stub");

        return stub;
      },
    }),
  );
}

export const disconnectedChatGPT: ChatGPTConnectionView = {
  connection: { state: "disconnected" },
  login: null,
  model: "gpt-test",
};

const notCalled = (what: string) => () => Promise.reject(new Error(`this test must not ${what}`));

const chatgptSupervisor: Pick<
  ApiSupervisor,
  "getChatGPTConnection" | "startChatGPTLogin" | "completeChatGPTLogin" | "disconnectChatGPT"
> = {
  getChatGPTConnection: () => Promise.resolve(disconnectedChatGPT),
  startChatGPTLogin: notCalled("start a ChatGPT sign-in"),
  completeChatGPTLogin: notCalled("complete a ChatGPT sign-in"),
  disconnectChatGPT: notCalled("disconnect ChatGPT"),
};

export function apiSupervisor(overrides: Partial<ApiSupervisor> = {}): ApiSupervisor {
  return {
    scriptVersion: () => Promise.resolve(WORKER_VERSION),
    getStatus() {
      return Promise.resolve({ activeGeneration: { generation: null, epoch: 0 }, mainAhead: null });
    },
    submitProjectMessage: notCalled("submit a message"),
    projectEvents: notCalled("watch a conversation"),
    projectEntries: notCalled("page a conversation"),
    abortProjectRun: notCalled("abort a run"),
    freshProjectConversation: notCalled("start a fresh thread"),
    controlGeneration() {
      return Promise.reject(new Error("this test must not reach generation control"));
    },
    submitGeneration: notCalled("submit a generation"),
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
    getWorkspaceBackend: () => Promise.resolve("provider"),
    setWorkspaceBackend: (backend) => Promise.resolve({ ok: true, backend }),
    ...chatgptSupervisor,
    ...overrides,
  };
}

export function controlRequest(path: string, body: string): Request {
  return new Request(`https://cf-stumble.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

export async function decodedAnswer<E extends AnsweredEndpoint>(
  endpoint: E,
  response: Response,
): Promise<AnswerOf<E> | undefined> {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ANSWERS[endpoint])(await response.json()),
  );
}
