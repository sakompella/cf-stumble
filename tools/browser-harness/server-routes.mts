import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MISTYPED_REPOSITORY_URL,
  NEW_PROJECT,
  TOO_LARGE_REPOSITORY_URL,
  connectPayload,
  projectsPayload,
  refreshPayload,
  chatgptPayload,
  statusPayload,
} from "./fixtures.mjs";
import { isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
import type { ANSWERS, AnsweredEndpoint } from "../../src/api/answers.js";
import { PROBLEM_STATUS, type ProblemCode } from "../../src/api/problems.js";
import { matchEndpoint } from "../../src/api/endpoints.js";
import type { ScenarioState } from "./server-state.mjs";

export type RouteAnswer = Readonly<{ status: number; payload: JsonValue }>;

export function sendJson(res: ServerResponse, status: number, payload: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}

function field(body: JsonValue, key: string): JsonValue | undefined {
  return isJsonRecord(body) ? body[key] : undefined;
}

function readString(body: JsonValue, key: string): string | undefined {
  const value = field(body, key);

  return value !== undefined && isJsonString(value) ? value : undefined;
}

type JsonState = Pick<
  ScenarioState,
  "scenario" | "projects" | "isChatGPTConnected" | "generationLabel"
>;

type Answer<E extends AnsweredEndpoint> = Readonly<{
  status: number;
  payload: (typeof ANSWERS)[E]["Encoded"];
}>;

const INVALID_REQUEST: RouteAnswer = {
  status: 400,
  payload: { ok: false, error: { code: "invalid-connect-request" } },
};

const REFUSED_REPOSITORIES: ReadonlyMap<string, ProblemCode> = new Map([
  [MISTYPED_REPOSITORY_URL, "repository-not-accessible"],
  [TOO_LARGE_REPOSITORY_URL, "repository-too-large"],
]);

function connect(
  state: JsonState,
  body: JsonValue,
): Answer<"POST /api/projects/connect"> | RouteAnswer {
  const repositoryUrl = readString(body, "repositoryUrl");

  if (repositoryUrl === undefined || repositoryUrl === "") {
    return INVALID_REQUEST;
  }

  const refused = REFUSED_REPOSITORIES.get(repositoryUrl);

  if (refused !== undefined) {
    return { status: PROBLEM_STATUS[refused], payload: { ok: false, problem: { code: refused } } };
  }

  const already = state.projects.some((project) => project.id === NEW_PROJECT.id);

  if (!already) {
    state.projects = [...state.projects, NEW_PROJECT];
  }

  return { status: 200, payload: connectPayload(already) };
}

function disconnect(
  state: JsonState & Pick<ScenarioState, "conversations">,
  projectId: string,
): Answer<"POST /api/projects/:projectId/disconnect"> | RouteAnswer {
  const project = state.projects.find((entry) => entry.id === projectId);

  if (project === undefined || project.kind === "harness") {
    return { status: 404, payload: { ok: false, problem: { code: "unknown-project-id" } } };
  }

  if (state.conversations.barrier.held) {
    return { status: 409, payload: { ok: false, problem: { code: "run-active" } } };
  }

  state.projects = state.projects.filter((entry) => entry.id !== projectId);

  return { status: 200, payload: { ok: true, projectId, workspace: "removed" } };
}

type ServedRoutes = {
  readonly [
    E in
      | "GET /api/projects"
      | "GET /api/status"
      | "GET /api/chatgpt/connection"
      | "GET /api/workspace/backend"
      | "POST /api/projects/connect"
      | "POST /api/chatgpt/disconnect"
      | "POST /api/github/authorization/complete"
      | "GET /api/github/connection"
      | "POST /api/github/connection/refresh"
  ]: (state: JsonState, body: JsonValue) => Answer<E> | RouteAnswer;
};

export const JSON_ROUTES = {
  "GET /api/projects": (state) => ({ status: 200, payload: projectsPayload(state.projects) }),
  "GET /api/status": (state) => ({
    status: 200,
    payload: statusPayload(state.generationLabel),
  }),
  "GET /api/chatgpt/connection": (state) => ({
    status: 200,
    payload: chatgptPayload(state.isChatGPTConnected),
  }),
  "POST /api/github/authorization/complete": () => ({
    status: PROBLEM_STATUS["not-configured"],
    payload: { ok: false, problem: { code: "not-configured" } },
  }),
  "POST /api/chatgpt/disconnect": (state) => {
    state.isChatGPTConnected = false;

    return { status: 200, payload: chatgptPayload(false) };
  },
  "GET /api/workspace/backend": () => ({ status: 200, payload: { ok: true, backend: "provider" } }),
  "POST /api/projects/connect": connect,
  "GET /api/github/connection": (state) => ({
    status: 200,
    payload: refreshPayload(state.scenario),
  }),
  "POST /api/github/connection/refresh": (state) => ({
    status: 200,
    payload: refreshPayload(state.scenario),
  }),
} satisfies ServedRoutes;

function isServed(endpoint: string): endpoint is keyof typeof JSON_ROUTES {
  return Object.hasOwn(JSON_ROUTES, endpoint);
}

export function serveJsonRoute(
  req: IncomingMessage,
  path: string,
  state: ScenarioState,
  body: JsonValue,
): RouteAnswer | undefined {
  const match = matchEndpoint(req.method ?? "", path);

  if (match?.kind === "project" && match.endpoint === "POST /api/projects/:projectId/disconnect") {
    return disconnect(state, match.projectId);
  }

  return match?.kind === "fixed" && isServed(match.endpoint)
    ? JSON_ROUTES[match.endpoint](state, body)
    : undefined;
}
