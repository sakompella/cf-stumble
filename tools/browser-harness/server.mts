import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseScenario, type HarnessScenario, type ProjectEntry } from "./fixtures.mjs";
import type { GenerationRecord, GenerationState } from "./fixtures-generation.mjs";
import type { ThreadState } from "./fixtures-thread.mjs";
import { parseJsonRecordText, type JsonValue } from "./json.mjs";
import {
  acceptsHtml,
  sendJson,
  sendOwnerPage,
  serveJsonRoute,
  serveThreadRoutes,
} from "./server-routes.mjs";
import {
  initialState,
  resetState,
  threadOf,
  waitUntil,
  type RecordedRequest,
  type ScenarioState,
} from "./server-state.mjs";
import { serveTurn } from "./server-turn.mjs";

/**
 * A local stand-in for the Worker, serving the real owner page.
 *
 * The page markup and the inline script come from `src/page`, so the harness drives the code that
 * ships rather than a copy of it. Only the Supervisor is replaced, because a real turn would call
 * a paid model API and a real Cloudflare Access check needs a deployed environment. Everything the
 * page can observe about its own environment is kept identical: the same headers, the same policy
 * with a per-response nonce, and a turn that arrives as newline-delimited frames over time.
 *
 * The controls a case uses are functions on {@link HarnessServer} rather than test-only HTTP
 * routes, because a case and this server share one Node process. The two routes under `/__harness`
 * exist for a developer driving this server by hand with curl.
 */

const TURN_PATH = /^\/api\/projects\/([^/]+)\/turn$/u;

export type GenerationPatch = Readonly<{
  activeLabel?: number;
  epoch?: number;
  generations?: readonly GenerationRecord[];
}>;

export type HarnessServer = Readonly<{
  url: string;
  scenario: () => HarnessScenario;
  setScenario: (scenario: HarnessScenario) => void;
  requests: () => readonly RecordedRequest[];
  clearRequests: () => void;
  barrierReached: () => boolean;
  waitForBarrier: (timeoutMs?: number) => Promise<void>;
  release: () => void;
  responseClosed: () => boolean;
  waitForResponseClosed: (timeoutMs?: number) => Promise<void>;
  thread: (projectId: string) => ThreadState;
  projects: () => readonly ProjectEntry[];
  generation: () => GenerationState;
  setGeneration: (patch: GenerationPatch) => void;
  reset: (scenario?: HarnessScenario) => void;
  close: () => Promise<void>;
}>;

/**
 * Every request body, drained before anything answers.
 *
 * The server records what the page sent, so the body has to be read even on the routes that do not
 * need it; a route that answered without draining would leave the socket holding bytes and the
 * next request on that connection would start mid-body.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((whole, failed) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      whole(body);
    });
    req.on("error", failed);
  });
}

function serveHarnessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  state: ScenarioState,
): number | undefined {
  if (req.method === "GET" && url.pathname === "/__harness/requests") {
    sendJson(res, 200, { ok: true, requests: [...state.requests] });
    return 200;
  }
  if (req.method !== "POST" || url.pathname !== "/__harness/scenario") {
    return undefined;
  }
  const requested = parseScenario(url.searchParams.get("name"));
  if (requested !== undefined) {
    state.scenario = requested;
  }
  const status = requested === undefined ? 400 : 200;
  sendJson(res, status, { ok: requested !== undefined, scenario: state.scenario });
  return status;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: ScenarioState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const body = await readBody(req);
  const parsed: JsonValue = parseJsonRecordText(body) ?? null;
  const record = { method: req.method ?? "", path, body: parsed, status: 0 };
  state.requests.push(record);

  const turn = TURN_PATH.exec(path)?.[1];
  if (req.method === "POST" && turn !== undefined) {
    await serveTurn(res, state, decodeURIComponent(turn), record);
    return;
  }
  const harnessStatus = serveHarnessRoute(req, res, url, state);
  if (harnessStatus !== undefined) {
    record.status = harnessStatus;
    return;
  }
  if (req.method === "GET" && path === "/" && acceptsHtml(req.headers.accept)) {
    record.status = 200;
    sendOwnerPage(res);
    return;
  }
  if (req.method === "GET" && path === "/favicon.ico") {
    // A browser asks for this on every navigation and the owner API does not serve it. Answering
    // 204 keeps that request out of the browser's error log, where it would hide a real 404.
    record.status = 204;
    res.writeHead(204).end();
    return;
  }
  const answer = serveJsonRoute(req, path, state, parsed) ?? serveThreadRoutes(req, path, state);
  record.status = answer?.status ?? 404;
  sendJson(res, record.status, answer?.payload ?? { ok: false, error: { code: "not-found" } });
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

function controls(state: ScenarioState, url: string, close: () => Promise<void>): HarnessServer {
  return {
    url,
    scenario: () => state.scenario,
    setScenario: (next) => {
      state.scenario = next;
    },
    requests: () => state.requests.map((entry) => ({ ...entry })),
    clearRequests: () => {
      state.requests = [];
    },
    barrierReached: () => state.stream.barrierReached,
    waitForBarrier: (timeoutMs = 20_000) =>
      waitUntil(() => state.stream.barrierReached, timeoutMs, "the turn stream to reach its hold"),
    release: () => {
      state.stream.released = true;
    },
    responseClosed: () => state.stream.responseClosed,
    waitForResponseClosed: (timeoutMs = 20_000) =>
      waitUntil(
        () => state.stream.responseClosed,
        timeoutMs,
        "the browser to close the turn response",
      ),
    thread: (projectId) => threadOf(state, projectId),
    projects: () => [...state.projects],
    generation: () => state.generation,
    setGeneration: (patch) => {
      state.generation = {
        generations: patch.generations ?? state.generation.generations,
        activeLabel: patch.activeLabel ?? state.generation.activeLabel,
        epoch: patch.epoch ?? state.generation.epoch,
      };
    },
    reset: (scenario) => {
      resetState(state, scenario ?? state.scenario);
    },
    close,
  };
}

export function startHarnessServer(initialScenario?: HarnessScenario): Promise<HarnessServer> {
  const state = initialState(
    initialScenario ?? parseScenario(process.env.CF_STUMBLE_HARNESS_SCENARIO) ?? "ready",
  );

  const server = createServer((req, res) => {
    void handle(req, res, state).catch((error: Error) => {
      console.error(`harness server failed to answer ${req.url ?? "?"}: ${error.message}`);
      res.destroy();
    });
  });

  return new Promise((started, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!isAddressInfo(address)) {
        reject(new Error("the harness server did not report a TCP port"));
        return;
      }
      const close = (): Promise<void> =>
        new Promise((closed) => {
          server.closeAllConnections();
          server.close(() => {
            closed();
          });
        });
      started(controls(state, `http://127.0.0.1:${address.port}`, close));
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const running = await startHarnessServer();
  console.log(`harness server on ${running.url} serving scenario "${running.scenario()}"`);
  console.log(`switch it with: curl -X POST "${running.url}/__harness/scenario?name=timed-out"`);
}
