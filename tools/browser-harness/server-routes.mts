import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OWNER_PAGE_SCRIPT_FILE, ownerPageHtml } from "../../src/page/index.js";
import {
  NEW_PROJECT,
  authorizationPayload,
  connectPayload,
  projectsPayload,
  refreshPayload,
} from "./fixtures.mjs";
import {
  disconnect,
  finishLogin,
  readConnection,
  startLogin,
  type ChatGPTAnswer,
} from "./fixtures-chatgpt.mjs";
import { runGenerationCommand, statusPayload, submitGeneration } from "./fixtures-generation.mjs";
import { isJsonNumber, isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
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

export function acceptsHtml(accept: string | undefined): boolean {
  return (accept ?? "")
    .split(",")
    .some((entry) => (entry.split(";")[0] ?? "").trim().toLowerCase() === "text/html");
}

function field(body: JsonValue, key: string): JsonValue | undefined {
  return isJsonRecord(body) ? body[key] : undefined;
}

function readString(body: JsonValue, key: string): string | undefined {
  const value = field(body, key);

  return value !== undefined && isJsonString(value) ? value : undefined;
}

function readNumber(body: JsonValue, key: string): number | undefined {
  const value = field(body, key);

  return value !== undefined && isJsonNumber(value) ? value : undefined;
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

function submit(state: ScenarioState, body: JsonValue): RouteAnswer {
  const harnessCommit = readString(body, "harnessCommit");

  if (harnessCommit === undefined || harnessCommit === "") {
    return INVALID_REQUEST;
  }

  const answer = submitGeneration(state.generation, harnessCommit);
  state.generation = answer.next;

  return { status: answer.status, payload: answer.payload };
}

function command(
  kind: "activate" | "rollback",
): (state: ScenarioState, body: JsonValue) => RouteAnswer {
  return (state, body) => {
    const observedEpoch = readNumber(body, "observedEpoch");
    const label = readNumber(body, "label");

    if (observedEpoch === undefined || label === undefined) {
      return INVALID_REQUEST;
    }

    const answer = runGenerationCommand(state.generation, kind, observedEpoch, label);
    state.generation = answer.next;

    return { status: answer.status, payload: answer.payload };
  };
}

function chatgptRoute(
  next: (state: ScenarioState, body: JsonValue) => ChatGPTAnswer,
): (state: ScenarioState, body: JsonValue) => RouteAnswer {
  return (state, body) => {
    const answer = next(state, body);
    state.chatgpt = answer.next;

    return { status: answer.status, payload: answer.payload };
  };
}

function finishChatGPT(state: ScenarioState, body: JsonValue): ChatGPTAnswer {
  const attemptId = readString(body, "attemptId");
  const callbackUrl = readString(body, "callbackUrl");

  return attemptId === undefined || callbackUrl === undefined || !URL.canParse(callbackUrl)
    ? { status: 400, payload: INVALID_REQUEST.payload, next: state.chatgpt }
    : finishLogin(state.chatgpt, attemptId, callbackUrl);
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
    answer: (state) => statusPayload(state.generation, state.scenario),
  },
  {
    method: "GET",
    path: "/api/chatgpt/connection",
    answer: chatgptRoute((state) => readConnection(state.chatgpt)),
  },
  {
    method: "POST",
    path: "/api/chatgpt/login",
    answer: chatgptRoute((state) => startLogin(state.chatgpt)),
  },
  { method: "POST", path: "/api/chatgpt/login/complete", answer: chatgptRoute(finishChatGPT) },
  {
    method: "POST",
    path: "/api/chatgpt/disconnect",
    answer: chatgptRoute((state) => disconnect(state.chatgpt)),
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
  {
    method: "POST",
    path: "/api/github/authorization",
    answer: (state) => ({ status: 200, payload: authorizationPayload(state.scenario) }),
  },
  {
    method: "POST",
    path: "/api/github/authorization/complete",
    answer: (state) => ({ status: 200, payload: authorizationPayload(state.scenario) }),
  },
  { method: "POST", path: "/api/generations/submit", answer: submit },
  { method: "POST", path: "/api/generations/activate", answer: command("activate") },
  { method: "POST", path: "/api/generations/rollback", answer: command("rollback") },
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
