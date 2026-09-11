import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ownerPageHtml } from "../../src/page/index.js";
import { NEW_PROJECT, authorizationPayload, connectPayload, projectsPayload } from "./fixtures.mjs";
import { runGenerationCommand, statusPayload, submitGeneration } from "./fixtures-generation.mjs";
import { threadPayload } from "./fixtures-thread.mjs";
import { isJsonNumber, isJsonRecord, isJsonString, type JsonValue } from "./json.mjs";
import { threadOf, type ScenarioState } from "./server-state.mjs";

/**
 * What the harness server answers, apart from the streaming turn.
 *
 * Every route reads the state the stub keeps rather than a frozen payload, because the page checks
 * its own work against it: a completed turn re-reads the thread, a submission is followed by a
 * status read, and a case that asserted on a ledger frozen at its starting epoch would pass a page
 * that never re-read anything.
 */

export type RouteAnswer = Readonly<{ status: number; payload: JsonValue }>;

export function sendJson(res: ServerResponse, status: number, payload: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

/**
 * The owner page, behind the headers the Worker sends.
 *
 * The Content Security Policy is copied from `src/routes/page.ts` character for character. That
 * duplication is deliberate, and it is the reason this harness can catch a page that outgrows the
 * policy: a looser policy here would let an inline handler or an external asset work locally and
 * be refused in production.
 */
export function sendOwnerPage(res: ServerResponse): void {
  const nonce = randomUUID();
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none'; connect-src 'self'; img-src 'self'; ` +
      `style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
      `form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(ownerPageHtml(nonce));
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

/** Every fixed-path route, as data. The page's own paths are the only keys that matter. */
const JSON_ROUTES: readonly Readonly<{
  method: string;
  path: string;
  answer: (state: ScenarioState, body: JsonValue) => RouteAnswer;
}>[] = [
  {
    method: "GET",
    path: "/api/projects",
    answer: (state) => ({
      status: 200,
      payload: projectsPayload(state.scenario, state.projects),
    }),
  },
  {
    method: "GET",
    path: "/api/status",
    answer: (state) => statusPayload(state.generation, state.scenario),
  },
  {
    method: "GET",
    path: "/api/github/connection",
    answer: (state) => ({ status: 200, payload: authorizationPayload(state.scenario) }),
  },
  { method: "POST", path: "/api/projects/connect", answer: connect },
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

const THREAD_PATH = /^\/api\/projects\/([^/]+)\/thread$/u;

const FRESH_THREAD_PATH = /^\/api\/projects\/([^/]+)\/thread\/fresh$/u;

/**
 * Reading a thread, and replacing it. A fresh thread keeps the project, drops every message, and
 * moves to the next revision, which is what the Supervisor's own reset does (ADR-0038).
 */
export function serveThreadRoutes(
  req: IncomingMessage,
  path: string,
  state: ScenarioState,
): RouteAnswer | undefined {
  const read = THREAD_PATH.exec(path)?.[1];

  if (req.method === "GET" && read !== undefined) {
    const projectId = decodeURIComponent(read);

    return { status: 200, payload: threadPayload(projectId, threadOf(state, projectId)) };
  }

  const fresh = FRESH_THREAD_PATH.exec(path)?.[1];

  if (req.method === "POST" && fresh !== undefined) {
    const projectId = decodeURIComponent(fresh);
    const replaced = { revision: threadOf(state, projectId).revision + 1, messageCount: 0 };
    state.threads.set(projectId, replaced);

    return { status: 200, payload: threadPayload(projectId, replaced) };
  }

  return undefined;
}
