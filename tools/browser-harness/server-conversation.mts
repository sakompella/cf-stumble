import type { ServerResponse } from "node:http";
import { isJsonRecord, isJsonString, type JsonValue } from "../json.mjs";
import type { ConversationApiSupervisor } from "../../src/routes/conversations.js";
import type { ConversationProblem } from "../../src/supervisor/conversations/conversation-result.js";
import { entriesRequest, eventsFrom } from "../../src/routes/entries-request.js";
import { sendJson } from "./server-routes.mjs";
import type { RequestRecord, ScenarioState } from "./server-state.mjs";

type SupervisorAnswer<Call extends keyof ConversationApiSupervisor> = Awaited<
  ReturnType<ConversationApiSupervisor[Call]>
>;

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)\/(.+)$/u;

const ACTIONS = ["messages", "events", "entries", "abort", "thread/fresh"] as const;

type ConversationRoute = Readonly<{
  projectId: string;
  action: (typeof ACTIONS)[number];
  params: URLSearchParams;
}>;

export function conversationRoute(method: string, url: URL): ConversationRoute | undefined {
  const [, projectId, suffix] = PROJECT_ROUTE.exec(url.pathname) ?? [];
  const action = ACTIONS.find((known) => known === suffix);

  if (projectId === undefined || action === undefined) {
    return undefined;
  }

  return (method === "GET") === (action === "events" || action === "entries")
    ? { projectId: decodeURIComponent(projectId), action, params: url.searchParams }
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
  from: number | undefined,
): Promise<void> {
  const stream = await state.conversations.watch(projectId, from);
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
  res.write(`${JSON.stringify([["r", stream.value]])}\n`);
  stream.start((call) => {
    if (call.kind === "value") res.write(`${JSON.stringify(call.ops)}\n`);

    return Promise.resolve();
  });
}

async function serveEntries(
  res: ServerResponse,
  state: ScenarioState,
  projectId: string,
  params: URLSearchParams,
  record: RequestRecord,
): Promise<void> {
  const request = entriesRequest(params);

  if (request === undefined) {
    record.status = 400;
    sendJson(res, 400, { ok: false, error: { code: "invalid-entries-request" } });

    return;
  }

  const page = await state.conversations.page(projectId, request);
  record.status = 200;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(page);
}

function refuse(
  res: ServerResponse,
  record: RequestRecord,
  status: number,
  code: ConversationProblem["code"],
): void {
  record.status = status;
  sendJson(res, status, { ok: false, problem: { code } });
}

function answer(
  res: ServerResponse,
  record: RequestRecord,
  status: number,
  result: SupervisorAnswer<"abortProjectRun" | "freshProjectConversation" | "submitProjectMessage">,
): void {
  record.status = status;
  sendJson(res, status, result);
}

export async function serveConversation(
  res: ServerResponse,
  state: ScenarioState,
  route: ConversationRoute,
  body: JsonValue,
  record: RequestRecord,
): Promise<void> {
  const { projectId, action, params } = route;

  if (!knownProject(state, projectId)) {
    refuse(res, record, 404, "unknown-project-id");

    return;
  }

  if (action === "events") {
    record.status = 200;
    await streamEvents(res, state, projectId, eventsFrom(params) ?? undefined);

    return;
  }

  if (action === "entries") {
    await serveEntries(res, state, projectId, params, record);

    return;
  }

  if (action === "abort") {
    await state.conversations.abort(projectId);
    answer(res, record, 200, { ok: true });

    return;
  }

  if (action === "thread/fresh") {
    const conversationId = await state.conversations.fresh(projectId);
    answer(res, record, 200, { ok: true, conversationId: String(conversationId) });

    return;
  }

  const message = messageOf(body);

  if (message === undefined) {
    refuse(res, record, 400, "invalid-message");

    return;
  }

  const submissionId = await state.conversations.submit(
    projectId,
    message.content,
    message.requestId,
  );

  answer(res, record, 202, { ok: true, submissionId });
}
