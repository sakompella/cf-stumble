import type { IncomingMessage, ServerResponse } from "node:http";
import {
  NEW_PROJECT,
  connectPayload,
  projectsPayload,
  refreshPayload,
  chatgptPayload,
  STATUS_PAYLOAD,
} from "./fixtures.mjs";
import { isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
import type { ANSWERS, AnsweredEndpoint } from "../../src/api/answers.js";
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

type JsonState = Pick<ScenarioState, "scenario" | "projects" | "isChatGPTConnected">;

type Answer<E extends AnsweredEndpoint> = Readonly<{
  status: number;
  payload: (typeof ANSWERS)[E]["Encoded"];
}>;

const INVALID_REQUEST: RouteAnswer = {
  status: 400,
  payload: { ok: false, error: { code: "invalid-connect-request" } },
};

function connect(
  state: JsonState,
  body: JsonValue,
): Answer<"POST /api/projects/connect"> | RouteAnswer {
  const repositoryUrl = readString(body, "repositoryUrl");

  if (repositoryUrl === undefined || repositoryUrl === "") {
    return INVALID_REQUEST;
  }

  const already = state.projects.some((project) => project.id === NEW_PROJECT.id);

  if (!already) {
    state.projects = [...state.projects, NEW_PROJECT];
  }

  return { status: 200, payload: connectPayload(already) };
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
      | "GET /api/github/connection"
      | "POST /api/github/connection/refresh"
  ]: (state: JsonState, body: JsonValue) => Answer<E> | RouteAnswer;
};

export const JSON_ROUTES = {
  "GET /api/projects": (state) => ({ status: 200, payload: projectsPayload(state.projects) }),
  "GET /api/status": () => ({ status: 200, payload: STATUS_PAYLOAD }),
  "GET /api/chatgpt/connection": (state) => ({
    status: 200,
    payload: chatgptPayload(state.isChatGPTConnected),
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
  const endpoint = matchEndpoint(req.method ?? "", path)?.endpoint;

  return endpoint !== undefined && isServed(endpoint)
    ? JSON_ROUTES[endpoint](state, body)
    : undefined;
}
