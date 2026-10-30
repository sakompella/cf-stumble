import type { ServerResponse } from "node:http";
import { isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
import { sendJson } from "./server-routes.mjs";
import type { RequestRecord, ScenarioState } from "./server-state.mjs";

/**
 * The conversation routes, served from the stub's Pi Durable conversations.
 *
 * The events response writes the snapshot and then each event as its own line, as the Supervisor
 * does, and stays open until the browser closes it.
 */

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)\/(.+)$/u;

const ACTIONS = ["messages", "events", "abort", "thread/fresh"] as const;

type ConversationRoute = Readonly<{ projectId: string; action: (typeof ACTIONS)[number] }>;

export function conversationRoute(method: string, path: string): ConversationRoute | undefined {
  const [, projectId, suffix] = PROJECT_ROUTE.exec(path) ?? [];
  const action = ACTIONS.find((known) => known === suffix);

  if (projectId === undefined || action === undefined) {
    return undefined;
  }

  return (method === "GET") === (action === "events")
    ? { projectId: decodeURIComponent(projectId), action }
    : undefined;
}

function knownProject(state: ScenarioState, projectId: string): boolean {
  return state.projects.some((project) => project.id === projectId);
}

function messageOf(body: JsonValue): Readonly<{ content: string; requestId: string }> | undefined {
  if (!isJsonRecord(body)) {
    return undefined;
  }

  const { content, requestId } = body;

  return content !== undefined &&
    requestId !== undefined &&
    isJsonString(content) &&
    isJsonString(requestId) &&
    content.trim() !== "" &&
    requestId !== ""
    ? { content, requestId }
    : undefined;
}

async function streamEvents(
  res: ServerResponse,
  state: ScenarioState,
  projectId: string,
): Promise<void> {
  const stream = await state.conversations.watch(projectId);
  const counts = state.openEventStreams;
  counts.set(projectId, (counts.get(projectId) ?? 0) + 1);

  res.on("close", () => {
    counts.set(projectId, (counts.get(projectId) ?? 1) - 1);
    void stream.stop();
  });
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.write(`${JSON.stringify(stream.snapshot)}\n`);
  stream.start((events) => {
    for (const event of events) {
      res.write(`${JSON.stringify(event)}\n`);
    }

    return Promise.resolve();
  });
}

function refuse(res: ServerResponse, record: RequestRecord, status: number, code: string): void {
  record.status = status;
  sendJson(res, status, { ok: false, problem: { code } });
}

export async function serveConversation(
  res: ServerResponse,
  state: ScenarioState,
  route: ConversationRoute,
  body: JsonValue,
  record: RequestRecord,
): Promise<void> {
  const { projectId, action } = route;

  if (!knownProject(state, projectId)) {
    refuse(res, record, 404, "unknown-project-id");

    return;
  }

  if (state.scenario === "no-active-generation") {
    refuse(res, record, 503, "no-active-generation");

    return;
  }

  if (action === "events") {
    record.status = 200;
    await streamEvents(res, state, projectId);

    return;
  }

  if (action === "abort") {
    await state.conversations.abort(projectId);
    record.status = 200;
    sendJson(res, 200, { ok: true });

    return;
  }

  if (action === "thread/fresh") {
    const conversationId = await state.conversations.fresh(projectId);
    record.status = 200;
    sendJson(res, 200, { ok: true, conversationId });

    return;
  }

  const message = messageOf(body);

  if (message === undefined) {
    refuse(res, record, 400, "invalid-message");

    return;
  }

  if (state.scenario === "workspace-busy") {
    refuse(res, record, 409, "workspace-busy");

    return;
  }

  const submissionId = await state.conversations.submit(
    projectId,
    message.content,
    message.requestId,
  );

  record.status = 202;
  sendJson(res, 202, { ok: true, submissionId });
}
