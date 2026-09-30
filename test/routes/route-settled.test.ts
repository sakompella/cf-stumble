import { afterEach, expect, test, vi } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import { ownerApiSupervisor as supervisor, ownerScope } from "./helpers.js";

/**
 * `route.settled`: one event per owner API request that reaches the workspace, with a server-made
 * request id that also reaches the Supervisor call the route makes.
 */

const ORIGIN = "https://cf-stumble.test";

afterEach(() => {
  vi.restoreAllMocks();
});

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function post(path: string, body: Readonly<Record<string, string>>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

test("a connection read logs one info event, and the Supervisor receives the same request id", async () => {
  const events = capturedEvents();
  const received: (string | undefined)[] = [];

  const response = await routeOwnerApiRequest(
    get("/api/github/connection"),
    supervisor({
      getGitHubConnection: (requestId) => {
        received.push(requestId);

        return Promise.resolve({
          state: "connected",
          login: "someone",
          source: "device-authorization",
        });
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  const settled = named(events(), "route.settled");
  expect(settled).toEqual([
    expect.objectContaining({
      level: "info",
      route: "/api/github/connection",
      method: "GET",
      status: 200,
      applicationOutcome: "ok",
      clientAborted: null,
      phase: "body",
    }),
  ]);
  expect(settled[0]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(received).toEqual([settled[0]?.requestId]);
});

test("a 200 that needs a reconnect is degraded, at warn", async () => {
  const events = capturedEvents();

  const response = await routeOwnerApiRequest(
    get("/api/github/connection"),
    supervisor({
      getGitHubConnection: () =>
        Promise.resolve({ state: "reconnect-required", reason: "workspace-unavailable" }),
    }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(named(events(), "route.settled").at(0)).toMatchObject({
    level: "warn",
    status: 200,
    applicationOutcome: "degraded",
  });
});

test("a thrown status read is a fault at error, with the status the client saw", async () => {
  const events = capturedEvents();

  const response = await routeOwnerApiRequest(
    get("/api/github/connection"),
    supervisor({ getGitHubConnection: () => Promise.reject(new Error("boom")) }),
    ownerScope,
  );

  expect(response.status).toBe(503);
  expect(named(events(), "route.settled").at(0)).toMatchObject({
    level: "error",
    status: 503,
    applicationOutcome: "fault",
  });
});

test("a refused request is a warning", async () => {
  const events = capturedEvents();

  const response = await routeOwnerApiRequest(
    new Request(`${ORIGIN}/api/workspace/reset`, { method: "POST" }),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(403);
  expect(named(events(), "route.settled").at(0)).toMatchObject({
    level: "warn",
    route: "/api/workspace/reset",
    status: 403,
    applicationOutcome: "refused",
  });
});

test("a client that left is recorded, and the request is still logged", async () => {
  const events = capturedEvents();
  const controller = new AbortController();
  controller.abort();

  await routeOwnerApiRequest(
    get("/api/projects", { signal: controller.signal }),
    supervisor(),
    ownerScope,
  );

  expect(named(events(), "route.settled").at(0)).toMatchObject({
    level: "warn",
    applicationOutcome: "ok",
    clientAborted: true,
  });
});

test("a turn is logged at its headers without reading the stream", async () => {
  const events = capturedEvents();
  const pull = vi.fn();
  const frames = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });

  const response = await routeOwnerApiRequest(
    post("/api/projects/sample-project-one/turn", { prompt: "do not log this prompt" }),
    supervisor({ runProjectTurn: () => Promise.resolve({ ok: true, frames }) }),
    ownerScope,
  );

  expect(response.status).toBe(200);
  expect(named(events(), "route.settled")).toEqual([
    expect.objectContaining({
      route: "/api/projects/:projectId/turn",
      method: "POST",
      status: 200,
      applicationOutcome: "ok",
      phase: "headers",
    }),
  ]);
  expect(pull, "nobody read the stream").not.toHaveBeenCalled();
  expect(frames.locked).toBe(false);
  expect(everythingLogged()).not.toContain("do not log this prompt");
});

test("requests that never touch the workspace stay quiet", async () => {
  const events = capturedEvents();

  await routeOwnerApiRequest(get("/api/status"), supervisor(), ownerScope);
  await routeOwnerApiRequest(get("/api/projects/some-id/thread"), supervisor(), ownerScope);

  expect(named(events(), "route.settled")).toEqual([]);
});

test("overlapping requests each get their own id, whatever the client sent", async () => {
  const events = capturedEvents();
  const forged = "00000000-0000-4000-8000-000000000000";
  const received: (string | undefined)[] = [];

  const routeOne = (headers: HeadersInit) =>
    routeOwnerApiRequest(
      get(`/api/github/connection?requestId=${forged}`, { headers }),
      supervisor({
        getGitHubConnection: async (requestId) => {
          await Promise.resolve();
          received.push(requestId);

          return { state: "disconnected" };
        },
      }),
      ownerScope,
    );

  await Promise.all([
    routeOne({ "x-request-id": forged, cookie: "session=secret-cookie" }),
    routeOne({ "cf-ray": forged }),
    routeOne({}),
  ]);

  const ids = named(events(), "route.settled").map((entry) => entry.requestId);
  expect(new Set(ids).size).toBe(3);
  expect(ids).not.toContain(forged);
  expect(received.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
    ids.toSorted((a, b) => String(a).localeCompare(String(b))),
  );
  expect(everythingLogged()).not.toMatch(/secret-cookie|requestId=|x-request-id/u);
});

test("the event carries the route pattern and never the path, query, or project id", async () => {
  const events = capturedEvents();

  await routeOwnerApiRequest(
    post("/api/projects/secret-project-name/disconnect?token=abc", {}),
    supervisor({
      disconnectProject: () =>
        Promise.resolve({ ok: false, problem: { code: "unknown-project-id" } }),
    }),
    ownerScope,
  );

  const settled = named(events(), "route.settled");
  expect(settled.at(0)).toMatchObject({ route: "/api/projects/:projectId/disconnect" });
  expect(JSON.stringify(settled)).not.toMatch(/secret-project-name|token=abc/u);
});
