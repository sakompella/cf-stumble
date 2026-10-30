// oxlint-disable anti-slop/no-unknown-parameters -- The Supervisor RPC method takes request data as `unknown` and parses it itself.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";
import { projectIdFromPath } from "./route-pattern.js";
import type { ProjectTurnRun, ProjectTurnRunProblemCode } from "../supervisor/projects/index.js";

/**
 * The body carries a prompt and nothing else. A tenant, conversation, model, lease, and generation are
 * all held by the Supervisor, so this route cannot be talked into running a turn on someone else's
 * thread.
 */
export type TurnApiSupervisor = Readonly<{
  runProjectTurn: (projectId: unknown, prompt: unknown) => Promise<ProjectTurnRun>;
}>;

/**
 * The table is total over every code the thread surface and turn path can produce, so the compiler
 * fails when a new code appears rather than a default status answering a fault nobody chose.
 */
const TURN_STATUS = {
  "invalid-project-id": 400,
  "invalid-prompt": 400,
  "invalid-messages": 400,
  "unknown-project-id": 404,
  "turn-conflict": 409,
  "stale-revision": 409,
  "turn-not-active": 409,
  "turn-expired": 409,
  "turn-lease-lost": 409,
  "turn-active": 409,
  "workspace-busy": 409,
  "unreadable-thread": 500,
  "no-active-generation": 503,
  "mount-failed": 503,
  "workspace-unavailable": 503,
  "turn-not-started": 503,
} as const satisfies Record<ProjectTurnRunProblemCode, number>;

const TurnBody = Schema.Struct({ prompt: Schema.String });

/**
 * `nosniff` because a stream of JSON lines must not be sampled into another content type. Cancelling
 * this body tells the Supervisor the browser is gone, so nothing here buffers it.
 */
function turnStreamResponse(frames: ReadableStream<Uint8Array>): Response {
  return new Response(frames, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const turnResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: TurnApiSupervisor, projectId: string) {
    const { prompt } = yield* decodeRequestBody(request, TurnBody);
    const run = yield* callSupervisor(() => supervisor.runProjectTurn(projectId, prompt));

    return run.ok
      ? turnStreamResponse(run.frames)
      : Response.json(
          { ok: false, problem: { code: run.problem.code } },
          { status: TURN_STATUS[run.problem.code] },
        );
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-turn-request")),
  ),
);

export function routeProjectTurnRequest(
  request: Request,
  supervisor: TurnApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  const projectId = projectIdFromPath(new URL(request.url).pathname, "/turn");

  if (projectId === undefined || request.method !== "POST") {
    return undefined;
  }

  return turnResponse(request, supervisor, projectId);
}
