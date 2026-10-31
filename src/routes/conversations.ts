import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";
import { projectIdFromPath, type ProjectRouteSuffix } from "./route-pattern.js";
import type {
  ConversationProblem,
  ConversationResult,
} from "../supervisor/conversations/conversation-result.js";

/**
 * A client names a project and nothing else: the Supervisor holds which conversation, generation and
 * workspace serve it, so these routes cannot be talked into another project's conversation.
 */
export type ConversationApiSupervisor = Readonly<{
  submitProjectMessage: (
    projectId: string,
    content: string,
    requestId: string,
  ) => Promise<ConversationResult<{ submissionId: number }>>;
  projectEvents: (
    projectId: string,
  ) => Promise<ConversationResult<{ events: ReadableStream<Uint8Array> }>>;
  abortProjectRun: (projectId: string) => Promise<ConversationResult<object>>;
  freshProjectConversation: (
    projectId: string,
  ) => Promise<ConversationResult<{ conversationId: string }>>;
}>;

const PROBLEM_STATUS = {
  "invalid-project-id": 400,
  "invalid-message": 400,
  "unknown-project-id": 404,
  "workspace-busy": 409,
  "no-active-generation": 503,
  "mount-failed": 503,
  "generation-failed": 503,
} as const satisfies Record<ConversationProblem["code"], number>;

const MessageBody = Schema.Struct({ content: Schema.String, requestId: Schema.String });

function problemResponse(problem: ConversationProblem): Response {
  return Response.json({ ok: false, problem }, { status: PROBLEM_STATUS[problem.code] });
}

/** `nosniff` because a stream of JSON lines must not be sampled into another content type. */
function eventsResponse(events: ReadableStream<Uint8Array>): Response {
  return new Response(events, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
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

const messageResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: ConversationApiSupervisor, projectId: string) {
    const { content, requestId } = yield* decodeRequestBody(request, MessageBody);

    return yield* answer(() => supervisor.submitProjectMessage(projectId, content, requestId), 202);
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-message-request")),
  ),
);

function routeFor(
  request: Request,
  method: "GET" | "POST",
  suffix: ProjectRouteSuffix,
): string | undefined {
  return request.method === method
    ? projectIdFromPath(new URL(request.url).pathname, suffix)
    : undefined;
}

export function routeConversationRequest(
  request: Request,
  supervisor: ConversationApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  const messages = routeFor(request, "POST", "/messages");

  if (messages !== undefined) return messageResponse(request, supervisor, messages);

  const events = routeFor(request, "GET", "/events");

  if (events !== undefined) {
    return callSupervisor(() => supervisor.projectEvents(events)).pipe(
      Effect.map((result) =>
        result.ok ? eventsResponse(result.events) : problemResponse(result.problem),
      ),
    );
  }

  const abort = routeFor(request, "POST", "/abort");

  if (abort !== undefined) return answer(() => supervisor.abortProjectRun(abort));

  const fresh = routeFor(request, "POST", "/thread/fresh");

  if (fresh !== undefined) return answer(() => supervisor.freshProjectConversation(fresh));

  return undefined;
}
