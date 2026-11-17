import type { Model } from "../../../src/page/client/model.js";
import { init } from "../../../src/page/client/update.js";
import { settled, type SentRequest } from "./requests.js";

export const REPOSITORY = {
  kind: "repository",
  id: "repo",
  displayName: "hello-world",
  repositoryUrl: "https://github.com/o/r",
} as const;

export const OTHER = {
  kind: "repository",
  id: "other",
  displayName: "new-repo",
  repositoryUrl: "https://github.com/o/n",
} as const;

export const HARNESS = { kind: "harness", id: "harness", displayName: "harness" } as const;

export const LOGIN = {
  attemptId: "attempt-1",
  authorizeUrl: "https://auth.example/authorize?state=s",
  expiresAt: 1,
};

export type ServerState = Readonly<{
  projects: readonly (typeof REPOSITORY | typeof OTHER | typeof HARNESS)[];
  label: number;
  chatgpt: "connected" | "signing-in";
}>;

export const BEFORE: ServerState = {
  projects: [REPOSITORY, HARNESS],
  label: 1,
  chatgpt: "connected",
};

export function answering(state: ServerState): (request: SentRequest) => Promise<Response> {
  const answers = new Map<string, object>([
    ["/api/projects", { ok: true, projects: state.projects }],
    [
      "/api/status",
      {
        activeGeneration: {
          generation: {
            label: state.label,
            harnessCommit: `commit-${state.label}`,
            status: "ready",
          },
          epoch: 3,
        },
        mainAhead: null,
      },
    ],
    [
      "/api/github/connection",
      {
        ok: true,
        github: { state: "connected", login: "octocat", source: "device-authorization" },
        checkedAt: 1,
      },
    ],
    [
      "/api/chatgpt/connection",
      {
        ok: true,
        chatgpt:
          state.chatgpt === "connected"
            ? {
                connection: { state: "connected", expiresAt: 1 },
                login: null,
                model: "gpt-6.1-sol",
              }
            : { connection: { state: "disconnected" }, login: LOGIN, model: "gpt-6.1-sol" },
      },
    ],
    ["/api/workspace/backend", { ok: true, backend: "provider" }],
  ]);

  return (request) => Promise.resolve(Response.json(answers.get(request.path) ?? { ok: false }));
}

export async function loadedWith(state: ServerState): Promise<Model> {
  return (await settled(init(), answering(state))).model;
}
