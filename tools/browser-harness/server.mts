import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { INITIAL_THREAD, parseScenario, type HarnessScenario } from "./fixtures.mjs";
import { parseJsonRecordText } from "./json.mjs";
import {
  acceptsHtml,
  sendJson,
  sendOwnerPage,
  serveJsonRoute,
  serveScenarioSwitch,
  serveThreadRoutes,
  type RecordedRequest,
  type ScenarioState,
} from "./server-routes.mjs";
import { turnFrames } from "./turn-fixture.mjs";

/**
 * A local stand-in for the Worker, serving the real owner page.
 *
 * The page markup and the inline script come from `src/page`, so the harness drives the code that
 * ships rather than a copy of it. Only the Supervisor is replaced, because a real turn would call
 * a paid model API and a real Cloudflare Access check needs a deployed environment. Everything the
 * page can observe about its own environment is kept identical: the same headers, the same policy
 * with a per-response nonce, and a turn that arrives as newline-delimited frames over time.
 */

/** How long each frame waits behind the previous one. Slow enough to observe partial rendering. */
const FRAME_INTERVAL_MS = 120;

const TURN_PATH = /^\/api\/projects\/([^/]+)\/turn$/u;

export type HarnessServer = Readonly<{
  url: string;
  setScenario: (scenario: HarnessScenario) => void;
  scenario: () => HarnessScenario;
  requests: () => readonly RecordedRequest[];
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

/**
 * The turn, one frame at a time.
 *
 * Each frame is written and then awaited separately, so the response really is incremental: a page
 * that only paints when the body ends fails the streaming assertion instead of passing it by
 * accident. A browser that goes away mid-stream ends the loop, and the thread does not advance —
 * which is what makes the late-frame check meaningful, because an abandoned turn saves nothing.
 */
async function streamTurn(res: ServerResponse, state: ScenarioState): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const frame of turnFrames(state.current)) {
    await sleep(FRAME_INTERVAL_MS);
    if (res.writableEnded || res.destroyed) {
      return;
    }
    res.write(`${JSON.stringify(frame)}\n`);
    if (frame.kind === "saved") {
      state.thread = { revision: frame.revision, messageCount: frame.messageCount };
    }
  }
  res.end();
}

/** The two refusals a turn can receive before any frame exists, as HTTP facts. */
function turnRefusal(
  scenario: HarnessScenario,
): Readonly<{ status: number; code: string }> | undefined {
  if (scenario === "turn-conflict") {
    return { status: 409, code: "turn-conflict" };
  }
  if (scenario === "no-active-generation") {
    return { status: 503, code: "no-active-generation" };
  }
  return undefined;
}

async function serveTurn(res: ServerResponse, state: ScenarioState): Promise<void> {
  const refusal = turnRefusal(state.current);
  if (refusal === undefined) {
    await streamTurn(res, state);
    return;
  }
  sendJson(res, refusal.status, { ok: false, problem: { code: refusal.code } });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: ScenarioState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const body = await readBody(req);
  state.requests.push({
    method: req.method ?? "",
    path,
    body: parseJsonRecordText(body) ?? null,
  });

  if (req.method === "GET" && path === "/__harness/requests") {
    sendJson(res, 200, { ok: true, requests: [...state.requests] });
    return;
  }
  if (req.method === "GET" && path === "/" && acceptsHtml(req.headers.accept)) {
    sendOwnerPage(res);
    return;
  }
  if (req.method === "GET" && path === "/favicon.ico") {
    // A browser asks for this on every navigation and the owner API does not serve it. Answering
    // 204 keeps that request out of the browser's error log, where it would hide a real 404.
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && path === "/__harness/scenario") {
    serveScenarioSwitch(res, url, state);
    return;
  }
  if (serveJsonRoute(req, res, path, state) || serveThreadRoutes(req, res, path, state)) {
    return;
  }
  if (req.method === "POST" && TURN_PATH.test(path)) {
    await serveTurn(res, state);
    return;
  }
  sendJson(res, 404, { ok: false, error: { code: "not-found" } });
}

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

export function startHarnessServer(initialScenario?: HarnessScenario): Promise<HarnessServer> {
  const state: ScenarioState = {
    current: initialScenario ?? parseScenario(process.env.CF_STUMBLE_HARNESS_SCENARIO) ?? "ready",
    thread: INITIAL_THREAD,
    requests: [],
  };

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
      started({
        url: `http://127.0.0.1:${address.port}`,
        setScenario: (next) => {
          state.current = next;
        },
        scenario: () => state.current,
        requests: () => [...state.requests],
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => {
              closed();
            });
          }),
      });
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
