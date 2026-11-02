import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OWNER_PAGE_SCRIPT_FILE, ownerPageHtml } from "../../src/page/index.js";
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

export function sendOwnerPage(res: ServerResponse): void {
  const nonce = randomUUID();
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none'; connect-src 'self'; img-src 'self'; ` +
      `style-src 'nonce-${nonce}'; script-src 'self'; ` +
      `form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(ownerPageHtml(nonce));
}

export function isOwnerPageScriptPath(path: string): boolean {
  return path === OWNER_PAGE_SCRIPT_FILE.path;
}

export function sendOwnerPageScript(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(OWNER_PAGE_SCRIPT_FILE.source);
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
