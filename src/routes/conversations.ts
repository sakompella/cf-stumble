import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type EntriesRequest, eventsFrom, parseEntriesRequest } from "../entries-request.js";
import {
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  jsonError,
  refusal,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";
import { DEFAULT_RUN_BUDGET_MINUTES, RUN_BUDGET_MINUTES } from "../turn-budget.js";
import type {
  ConversationProblem,
  ConversationResult,
} from "../supervisor/conversations/conversation-result.js";

export type ConversationApiSupervisor = Readonly<{
  submitProjectMessage: (
    projectId: string,
    content: string,
    requestId: string,
    budgetMinutes: number,
  ) => Promise<ConversationResult<{ submissionId: number }>>;
  projectEvents: (
    projectId: string,
    from: number | undefined,
  ) => Promise<ConversationResult<{ events: ReadableStream<Uint8Array> }>>;
  projectEntries: (
    projectId: string,
    request: EntriesRequest,
  ) => Promise<ConversationResult<{ page: string }>>;
  abortProjectRun: (projectId: string) => Promise<ConversationResult<object>>;
  freshProjectConversation: (
    projectId: string,
  ) => Promise<ConversationResult<{ conversationId: string }>>;
}>;

const MessageBody = Schema.Struct({
  content: Schema.String,
  requestId: Schema.String,
  budgetMinutes: Schema.optional(Schema.Literals(RUN_BUDGET_MINUTES)),
});

function problemResponse(problem: ConversationProblem): Response {
  return refusal({ ok: false, problem });
}

function noStoreResponse(body: ReadableStream<Uint8Array> | string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function eventsResponse(events: ReadableStream<Uint8Array>): Response {
  return noStoreResponse(events, "application/x-ndjson; charset=utf-8");
}

function entriesPageResponse(page: string): Response {
  return noStoreResponse(page, "application/json; charset=utf-8");
}

function answer<T extends object>(
  call: () => Promise<ConversationResult<T>>,
  status = 200,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(call).pipe(
    Effect.map((result) =>
      result.ok ? Response.json(result, { status }) : problemResponse(result.problem),
    ),
  );
}

const messageResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: ConversationApiSupervisor,
  projectId: string,
) {
  const {
    content,
    requestId,
    budgetMinutes = DEFAULT_RUN_BUDGET_MINUTES,
  } = yield* decodeRequestBody(request, MessageBody);

  return yield* answer(
    () => supervisor.submitProjectMessage(projectId, content, requestId, budgetMinutes),
    202,
  );
}, invalidRequestBody("invalid-message-request"));

function eventsResponseFor(
  request: Request,
  projectId: string,
  supervisor: ConversationApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  const from = eventsFrom(new URL(request.url).searchParams);

  if (from === null) return Effect.succeed(jsonError("invalid-events-request"));

  return callSupervisor(() => supervisor.projectEvents(projectId, from)).pipe(
    Effect.map((result) =>
      result.ok ? eventsResponse(result.events) : problemResponse(result.problem),
    ),
  );
}

function entriesResponseFor(
  request: Request,
  projectId: string,
  supervisor: ConversationApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  const query = parseEntriesRequest(new URL(request.url).searchParams);

  if (query === undefined) return Effect.succeed(jsonError("invalid-entries-request"));

  return callSupervisor(() => supervisor.projectEntries(projectId, query)).pipe(
    Effect.map((result) =>
      result.ok ? entriesPageResponse(result.page) : problemResponse(result.problem),
    ),
  );
}

export const CONVERSATION_HANDLERS: Handlers<
  ConversationApiSupervisor,
  | "POST /api/projects/:projectId/messages"
  | "GET /api/projects/:projectId/events"
  | "GET /api/projects/:projectId/entries"
  | "POST /api/projects/:projectId/abort"
  | "POST /api/projects/:projectId/thread/fresh"
> = {
  "POST /api/projects/:projectId/messages": (request, projectId, supervisor) =>
    messageResponse(request, supervisor, projectId),
  "GET /api/projects/:projectId/events": eventsResponseFor,
  "GET /api/projects/:projectId/entries": entriesResponseFor,
  "POST /api/projects/:projectId/abort": (_request, projectId, supervisor) =>
    answer(() => supervisor.abortProjectRun(projectId)),
  "POST /api/projects/:projectId/thread/fresh": (_request, projectId, supervisor) =>
    answer(() => supervisor.freshProjectConversation(projectId)),
};
