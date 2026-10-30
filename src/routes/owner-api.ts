// oxlint-disable import/max-dependencies -- The owner API is where every route group meets, so it imports each of them.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { logRedactedCause, timed, type RequestId } from "../diagnostics.js";
import type { ActiveGeneration } from "../supervisor/generations/index.js";
import type { ProjectThreadProblem, ProjectThreadResult } from "../supervisor/threads/index.js";
import {
  handleGenerationControl,
  handleGenerationSubmission,
  type GenerationControlSupervisor,
  type GenerationSubmissionSupervisor,
} from "./generations.js";
import { routeChatGPTApiRequest, type ChatGPTApiSupervisor } from "./chatgpt.js";
import { callSupervisor, jsonError, SupervisorCallFailed } from "./json.js";
import { projectIdFromPath, routePattern } from "./route-pattern.js";
import { settleRoute } from "./route-settled.js";
import { routeProjectApiRequest, type ProjectApiSupervisor } from "./projects.js";
import { routeProjectTurnRequest, type TurnApiSupervisor } from "./turns.js";

/** A refused reset names why: a turn holds a lease, or the Workspace Host is changing files. */
type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "turn-active" | "workspace-busy" }> }>;

export type OwnerApiSupervisor = ChatGPTApiSupervisor &
  GenerationControlSupervisor &
  GenerationSubmissionSupervisor &
  ProjectApiSupervisor &
  TurnApiSupervisor & {
    readonly getActiveGeneration: () => Promise<ActiveGeneration>;
    readonly getProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
    readonly startFreshProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
    readonly resetWorkspace: () => Promise<WorkspaceResetResult>;
  };

function workspaceResetResponse(
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() =>
    timed(
      "workspace.reset",
      {},
      () => supervisor.resetWorkspace(),
      (reset) => (reset.ok ? { outcome: "reset" } : { outcome: reset.problem.code, level: "warn" }),
    ),
  ).pipe(Effect.map((reset) => Response.json(reset, { status: reset.ok ? 200 : 409 })));
}

/**
 * The active generation and the epoch a control request must observe.
 *
 * `generation` and `activationId` are written out as `null` when there is none, rather than left
 * off. `Response.json` drops an undefined field, so an instance with nothing active answered
 * `{"activeGeneration":{"epoch":0}}`, which reads like an active generation at epoch 0 to anyone
 * who has not read this file. The epoch is the control epoch and legitimately starts at 0.
 */
function statusResponse(
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.getActiveGeneration()).pipe(
    Effect.map((active) =>
      Response.json({
        activeGeneration: {
          generation: active.generation ?? null,
          epoch: active.epoch,
          activationId: active.activationId ?? null,
        },
      }),
    ),
  );
}

/**
 * Naming a project the catalog does not have is a 404, because the client asked for something that
 * does not exist. A live turn refusing a fresh thread is a 409. An unreadable thread is a fault.
 */
function threadResponse(
  read: () => Promise<ProjectThreadResult>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(read).pipe(
    Effect.map((result) => {
      if (result.ok) {
        return Response.json({ ok: true, thread: result.thread });
      }

      return Response.json(
        { ok: false, problem: result.problem },
        { status: threadProblemStatus(result.problem.code) },
      );
    }),
  );
}

function threadProblemStatus(code: ProjectThreadProblem["code"]): number {
  if (code === "unreadable-thread") return 500;

  if (code === "turn-active") return 409;

  return 404;
}

/**
 * Request data selects only one of the projects, a generation label, and an epoch within the one
 * Supervisor. It never names a Durable Object.
 */
export function routeOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response> {
  return settleRoute(request, (requestId) =>
    dispatchOwnerApiRequest(request, supervisor, requestId),
  );
}

/**
 * A rejected Supervisor call, or a defect anywhere in a route, is logged redacted and answered with
 * a bare 500, because its text can come from a generation's code or a workspace command and is not
 * this boundary's to hand out.
 */
function dispatchOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
  requestId: RequestId | undefined,
): Effect.Effect<Response> {
  return Effect.suspend(() => ownerApiRoute(request, supervisor, requestId)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
            const route = routePattern(new URL(request.url).pathname);
            const failure = Cause.squash(cause);
            const thrown = failure instanceof SupervisorCallFailed ? failure.cause : failure;
            logRedactedCause(`owner-api ${request.method} ${route}: internal-error`, thrown);

            return jsonError(500, "internal-error");
          }),
    ),
  );
}

function ownerApiRoute(
  request: Request,
  supervisor: OwnerApiSupervisor,
  requestId: RequestId | undefined,
): Effect.Effect<Response, SupervisorCallFailed> {
  const pathname = new URL(request.url).pathname;
  const projectRoute = routeProjectApiRequest(request, supervisor, requestId);

  if (projectRoute !== undefined) {
    return projectRoute;
  }

  const turnRoute = routeProjectTurnRequest(request, supervisor);

  if (turnRoute !== undefined) {
    return turnRoute;
  }

  const chatgptRoute = routeChatGPTApiRequest(request, supervisor);

  if (chatgptRoute !== undefined) {
    return chatgptRoute;
  }

  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/status") {
    return statusResponse(supervisor);
  }

  if (isPost && pathname === "/api/generations/submit") {
    return handleGenerationSubmission(request, supervisor);
  }

  if (isPost && pathname === "/api/generations/activate") {
    return handleGenerationControl(request, supervisor, "activate");
  }

  if (isPost && pathname === "/api/generations/rollback") {
    return handleGenerationControl(request, supervisor, "rollback");
  }

  if (isPost && pathname === "/api/workspace/reset") {
    return workspaceResetResponse(supervisor);
  }

  const threadProjectId = projectIdFromPath(pathname, "/thread");

  if (isGet && threadProjectId !== undefined) {
    return threadResponse(() => supervisor.getProjectThread(threadProjectId));
  }

  const freshProjectId = projectIdFromPath(pathname, "/thread/fresh");

  if (isPost && freshProjectId !== undefined) {
    return threadResponse(() => supervisor.startFreshProjectThread(freshProjectId));
  }

  return Effect.succeed(jsonError(404, "not-found"));
}
