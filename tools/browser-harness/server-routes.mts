import type { IncomingMessage, ServerResponse } from "node:http";
import {
  NEW_PROJECT,
  connectPayload,
  projectsPayload,
  refreshPayload,
  CHATGPT_PAYLOAD,
  STATUS_PAYLOAD,
} from "./fixtures.mjs";
import { isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
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

const INVALID_REQUEST: RouteAnswer = {
  status: 400,
  payload: { ok: false, problem: { code: "invalid-request" } },
};

function connect(state: ScenarioState, body: JsonValue): RouteAnswer {
  const repositoryUrl = readString(body, "repositoryUrl");

  if (repositoryUrl === undefined || repositoryUrl === "") {
    return INVALID_REQUEST;
  }

  const already = state.projects.some((project) => project.id === NEW_PROJECT.id);

  if (!already) {
    state.projects = [...state.projects, NEW_PROJECT];
  }

  return { status: 200, payload: connectPayload(state.scenario, already) };
}

const JSON_ROUTES: readonly Readonly<{
  method: string;
  path: string;
  answer: (state: ScenarioState, body: JsonValue) => RouteAnswer;
}>[] = [
  {
    method: "GET",
    path: "/api/projects",
    answer: (state) => ({ status: 200, payload: projectsPayload(state.projects) }),
  },
  {
    method: "GET",
    path: "/api/status",
    answer: () => ({ status: 200, payload: STATUS_PAYLOAD }),
  },
  {
    method: "GET",
    path: "/api/chatgpt/connection",
    answer: () => ({ status: 200, payload: CHATGPT_PAYLOAD }),
  },
  { method: "POST", path: "/api/projects/connect", answer: connect },
  {
    method: "GET",
    path: "/api/github/connection",
    answer: (state) => ({ status: 200, payload: refreshPayload(state.scenario) }),
  },
  {
    method: "POST",
    path: "/api/github/connection/refresh",
    answer: (state) => ({ status: 200, payload: refreshPayload(state.scenario) }),
  },
];

export function serveJsonRoute(
  req: IncomingMessage,
  path: string,
  state: ScenarioState,
  body: JsonValue,
): RouteAnswer | undefined {
  const route = JSON_ROUTES.find(
    (candidate) => candidate.method === req.method && candidate.path === path,
  );

  return route === undefined ? undefined : route.answer(state, body);
}
