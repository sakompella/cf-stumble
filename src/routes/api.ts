import * as Effect from "effect/Effect";
import { matchEndpoint, type Endpoint } from "../api/endpoints.js";
import {
  GENERATION_HANDLERS,
  type GenerationStatusSupervisor,
  type GenerationControlSupervisor,
  type GenerationSubmissionSupervisor,
} from "./generations.js";
import { CHATGPT_HANDLERS, type ChatGPTApiSupervisor } from "./chatgpt.js";
import {
  answeringInternalErrors,
  callSupervisor,
  jsonError,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";
import { PROJECT_HANDLERS, type ProjectApiSupervisor } from "./projects.js";
import {
  WORKSPACE_BACKEND_HANDLERS,
  type WorkspaceBackendApiSupervisor,
} from "./workspace-backend.js";
import { CONVERSATION_HANDLERS, type ConversationApiSupervisor } from "./conversations.js";

type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{
      ok: false;
      problem: Readonly<{ code: "run-active" | "workspace-busy" | "workspace-unavailable" }>;
    }>;

export type ApiSupervisor = ChatGPTApiSupervisor &
  GenerationStatusSupervisor &
  GenerationControlSupervisor &
  GenerationSubmissionSupervisor &
  ProjectApiSupervisor &
  ConversationApiSupervisor &
  WorkspaceBackendApiSupervisor & {
    readonly resetWorkspace: () => Promise<WorkspaceResetResult>;
  };

const HANDLERS: Handlers<ApiSupervisor, Endpoint> = {
  ...GENERATION_HANDLERS,
  ...PROJECT_HANDLERS,
  ...CONVERSATION_HANDLERS,
  ...CHATGPT_HANDLERS,
  ...WORKSPACE_BACKEND_HANDLERS,
  "POST /api/workspace/reset": (_request, supervisor) =>
    callSupervisor(() => supervisor.resetWorkspace()).pipe(
      Effect.map((reset) => Response.json(reset, { status: reset.ok ? 200 : 409 })),
    ),
};

export function routeApiRequest(
  request: Request,
  supervisor: ApiSupervisor,
): Effect.Effect<Response> {
  return Effect.suspend(() => apiRoute(request, supervisor)).pipe(answeringInternalErrors(request));
}

function apiRoute(
  request: Request,
  supervisor: ApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  const match = matchEndpoint(request.method, new URL(request.url).pathname);

  if (match === undefined) return Effect.succeed(jsonError(404, "not-found"));

  return match.kind === "fixed"
    ? HANDLERS[match.endpoint](request, supervisor)
    : HANDLERS[match.endpoint](request, match.projectId, supervisor);
}
