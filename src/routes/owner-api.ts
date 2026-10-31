import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import type { ActiveGeneration } from "../supervisor/generations.js";
import {
  handleGenerationControl,
  handleGenerationSubmission,
  type GenerationControlSupervisor,
  type GenerationSubmissionSupervisor,
} from "./generations.js";
import { routeChatGPTApiRequest, type ChatGPTApiSupervisor } from "./chatgpt.js";
import { callSupervisor, jsonError, SupervisorCallFailed } from "./json.js";
import { routePattern } from "./route-pattern.js";
import { routeProjectApiRequest, type ProjectApiSupervisor } from "./projects.js";
import { routeConversationRequest, type ConversationApiSupervisor } from "./conversations.js";

type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: "run-active" | "workspace-busy" }>;
    }>;

export type OwnerApiSupervisor = ChatGPTApiSupervisor &
  GenerationControlSupervisor &
  GenerationSubmissionSupervisor &
  ProjectApiSupervisor &
  ConversationApiSupervisor & {
    readonly getActiveGeneration: () => Promise<ActiveGeneration>;
    readonly resetWorkspace: () => Promise<WorkspaceResetResult>;
  };

function workspaceResetResponse(
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.resetWorkspace()).pipe(
    Effect.map((reset) => Response.json(reset, { status: reset.ok ? 200 : 409 })),
  );
}

function statusResponse(
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.getActiveGeneration()).pipe(
    Effect.map((active) =>
      Response.json({
        activeGeneration: {
          generation: active.generation ?? null,
          epoch: active.epoch,
        },
      }),
    ),
  );
}

export function routeOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
): Effect.Effect<Response> {
  return Effect.suspend(() => ownerApiRoute(request, supervisor)).pipe(
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
): Effect.Effect<Response, SupervisorCallFailed> {
  const pathname = new URL(request.url).pathname;
  const projectRoute = routeProjectApiRequest(request, supervisor);

  if (projectRoute !== undefined) {
    return projectRoute;
  }

  const conversationRoute = routeConversationRequest(request, supervisor);

  if (conversationRoute !== undefined) {
    return conversationRoute;
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

  return Effect.succeed(jsonError(404, "not-found"));
}
