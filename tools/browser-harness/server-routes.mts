import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ownerPageHtml } from "../../src/page/index.js";
import {
  authorizationPayload,
  connectPayload,
  controlPayload,
  parseScenario,
  projectsPayload,
  recoveryPayload,
  statusPayload,
  submitPayload,
  threadPayload,
  type HarnessScenario,
  type ThreadState,
} from "./fixtures.mjs";
import type { JsonValue } from "./json.mjs";

/**
 * What the harness server answers, apart from the streaming turn.
 *
 * Everything here is a recorded answer, so the page's own behaviour is the only thing under test.
 * The thread is the one piece of state the server keeps, because the page checks its own work
 * against it: a completed turn re-reads the thread, and a check that asserted on a thread frozen
 * at its starting revision would pass a page that never re-read anything.
 */

/**
 * One request the page made, as the server saw it.
 *
 * The page is the thing under test, so what it sent is evidence and what it displays afterwards is
 * not: a check that read `#activate-sent-epoch` would be asking the page to confirm its own claim.
 * These records let a check compare the value a reader can see against the value that left the
 * browser.
 */
export type RecordedRequest = Readonly<{ method: string; path: string; body: JsonValue }>;

/** The mutable part of the server: which recorded world it serves, and where the thread stands. */
export type ScenarioState = {
  current: HarnessScenario;
  thread: ThreadState;
  readonly requests: RecordedRequest[];
};

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

/** Every fixed-path JSON route, as data. The page's own paths are the only keys that matter. */
const JSON_ROUTES: readonly Readonly<{
  method: string;
  path: string;
  payload: (scenario: HarnessScenario) => JsonValue;
}>[] = [
  { method: "GET", path: "/api/projects", payload: (scenario) => projectsPayload(scenario) },
  { method: "GET", path: "/api/status", payload: () => statusPayload() },
  { method: "GET", path: "/api/recovery/latest", payload: () => recoveryPayload() },
  {
    method: "GET",
    path: "/api/github/connection",
    payload: (scenario) => authorizationPayload(scenario),
  },
  { method: "POST", path: "/api/projects/connect", payload: (s) => connectPayload(s) },
  { method: "POST", path: "/api/github/authorization", payload: (s) => authorizationPayload(s) },
  {
    method: "POST",
    path: "/api/github/authorization/complete",
    payload: (scenario) => authorizationPayload(scenario),
  },
  { method: "POST", path: "/api/generations/submit", payload: () => submitPayload() },
  {
    method: "POST",
    path: "/api/generations/activate",
    payload: () => controlPayload("activated", 2),
  },
  {
    method: "POST",
    path: "/api/generations/rollback",
    payload: () => controlPayload("rolled-back", 1),
  },
];

export function serveJsonRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  state: ScenarioState,
): boolean {
  const route = JSON_ROUTES.find(
    (candidate) => candidate.method === req.method && candidate.path === path,
  );
  if (route === undefined) {
    return false;
  }
  sendJson(res, 200, route.payload(state.current));
  return true;
}

/** The scenario switch: a POST the harness (or a developer with curl) makes by name. */
export function serveScenarioSwitch(res: ServerResponse, url: URL, state: ScenarioState): void {
  const requested = parseScenario(url.searchParams.get("name"));
  if (requested === undefined) {
    sendJson(res, 400, { ok: false, problem: { code: "unknown-scenario" } });
    return;
  }
  state.current = requested;
  sendJson(res, 200, { ok: true, scenario: requested });
}

const THREAD_PATH = /^\/api\/projects\/([^/]+)\/thread$/u;
const FRESH_THREAD_PATH = /^\/api\/projects\/([^/]+)\/thread\/fresh$/u;

/**
 * Reading a thread, and replacing it. A fresh thread keeps the project, drops every message, and
 * moves to the next revision, which is what the Supervisor's own reset does (ADR-0038).
 */
export function serveThreadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  state: ScenarioState,
): boolean {
  const thread = THREAD_PATH.exec(path)?.[1];
  if (req.method === "GET" && thread !== undefined) {
    sendJson(res, 200, threadPayload(decodeURIComponent(thread), state.thread));
    return true;
  }
  const fresh = FRESH_THREAD_PATH.exec(path)?.[1];
  if (req.method === "POST" && fresh !== undefined) {
    state.thread = { revision: state.thread.revision + 1, messageCount: 0 };
    sendJson(res, 200, threadPayload(decodeURIComponent(fresh), state.thread));
    return true;
  }
  return false;
}
