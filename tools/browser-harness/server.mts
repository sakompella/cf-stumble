import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseScenario, type HarnessScenario, type ProjectEntry } from "./fixtures.mjs";
import type { GenerationRecord, GenerationState } from "./fixtures-generation.mjs";
import { openConversations, type Conversations } from "./conversations.mjs";
import { parseJsonRecordText, type JsonValue } from "../json.mjs";
import {
  acceptsHtml,
  isOwnerPageScriptPath,
  sendJson,
  sendOwnerPage,
  sendOwnerPageScript,
  serveJsonRoute,
} from "./server-routes.mjs";
import { conversationRoute, serveConversation } from "./server-conversation.mjs";
import {
  initialState,
  waitUntil,
  type RecordedRequest,
  type ScenarioState,
} from "./server-state.mjs";

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
  waitForBarrier: (timeoutMs?: number) => Promise<void>;
  release: () => void;
  openEventStreams: (projectId: string) => number;
  entries: Conversations["entries"];
  projects: () => readonly ProjectEntry[];
  generation: () => GenerationState;
  chatgpt: () => ScenarioState["chatgpt"];
  setGeneration: (patch: GenerationPatch) => void;
  close: () => Promise<void>;
}>;

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

  const conversation = conversationRoute(req.method ?? "", path);

  if (conversation !== undefined) {
    await serveConversation(res, state, conversation, parsed, record);

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

  if (req.method === "GET" && isOwnerPageScriptPath(path)) {
    record.status = 200;
    sendOwnerPageScript(res);

    return;
  }

  if (req.method === "GET" && path === "/favicon.ico") {
    record.status = 204;
    res.writeHead(204).end();

    return;
  }

  const answer = serveJsonRoute(req, path, state, parsed);
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
    waitForBarrier: (timeoutMs = 20_000) =>
      waitUntil(
        () => state.conversations.barrier.reached,
        timeoutMs,
        "the tool call to reach its hold",
      ),
    release: () => {
      state.conversations.barrier.release();
    },
    openEventStreams: (projectId) => state.openEventStreams.get(projectId) ?? 0,
    entries: (projectId) => state.conversations.entries(projectId),
    projects: () => [...state.projects],
    generation: () => state.generation,
    chatgpt: () => state.chatgpt,
    setGeneration: (patch) => {
      state.generation = {
        generations: patch.generations ?? state.generation.generations,
        activeLabel: patch.activeLabel ?? state.generation.activeLabel,
        epoch: patch.epoch ?? state.generation.epoch,
      };
    },
    close,
  };
}

export async function startHarnessServer(
  initialScenario?: HarnessScenario,
): Promise<HarnessServer> {
  const scenario =
    initialScenario ?? parseScenario(process.env.CF_STUMBLE_HARNESS_SCENARIO) ?? "ready";

  const conversations = await openConversations(() => state.scenario);
  const state = initialState(scenario, conversations);

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

      const close = async (): Promise<void> => {
        await new Promise<void>((closed) => {
          server.closeAllConnections();
          server.close(() => {
            closed();
          });
        });
        await conversations.close();
      };

      started(controls(state, `http://127.0.0.1:${address.port}`, close));
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const running = await startHarnessServer();
  console.log(`harness server on ${running.url} serving scenario "${running.scenario()}"`);
  console.log(`switch it with: curl -X POST "${running.url}/__harness/scenario?name=ready-paused"`);
}
