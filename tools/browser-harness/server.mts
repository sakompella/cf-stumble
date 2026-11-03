import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HARNESS_CREDENTIALS, type HarnessScenario } from "./fixtures.mjs";
import { openConversations, type Conversations } from "./conversations.mjs";
import { parseJsonRecordText, type JsonValue } from "../json.mjs";
import { ownerPageResponse } from "../../src/routes/page.js";
import { sendJson, sendResponse, serveJsonRoute } from "./server-routes.mjs";
import { conversationRoute, serveConversation } from "./server-conversation.mjs";
import {
  initialState,
  waitUntil,
  type RecordedRequest,
  type ScenarioState,
} from "./server-state.mjs";

export type HarnessServer = Readonly<{
  url: string;
  requests: () => readonly RecordedRequest[];
  waitForBarrier: (timeoutMs?: number) => Promise<void>;
  release: () => void;
  openEventStreams: (projectId: string) => number;
  entries: Conversations["entries"];
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

const OWNER_AUTHORIZATION = `Basic ${Buffer.from(
  `${HARNESS_CREDENTIALS.username}:${HARNESS_CREDENTIALS.password}`,
).toString("base64")}`;

function gateRefusal(req: IncomingMessage): 401 | 403 | undefined {
  if (req.headers.authorization !== OWNER_AUTHORIZATION) return 401;

  const mutation = req.method !== "GET" && req.method !== "HEAD";
  const origin = req.headers.origin;

  return mutation && origin !== undefined && origin !== `http://${req.headers.host ?? ""}`
    ? 403
    : undefined;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: ScenarioState,
): Promise<void> {
  const refused = gateRefusal(req);

  if (refused !== undefined) {
    const challenge = { "www-authenticate": 'Basic realm="cf-stumble", charset="UTF-8"' };
    res.writeHead(refused, refused === 401 ? challenge : {}).end();

    return;
  }

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

  const page = ownerPageResponse(new Request(url, { method: req.method ?? "GET" }));

  if (page !== undefined) {
    record.status = page.status;
    await sendResponse(res, page);

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
    requests: () => state.requests.map((entry) => ({ ...entry })),
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
    close,
  };
}

export async function startHarnessServer(scenario: HarnessScenario): Promise<HarnessServer> {
  const conversations = await openConversations(scenario);
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
