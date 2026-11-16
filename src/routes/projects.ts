import * as Effect from "effect/Effect";
import { ConnectRequest } from "../api/answers.js";
import {
  answer,
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  refusal,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";
import type { SelectableCatalog } from "../selectable-projects.js";
import type {
  ConnectRepositoryResult,
  DisconnectRepositoryResult,
  GitHubAuthorizationOutcome,
  GitHubConnectionRecord,
  GitHubRefreshOutcome,
} from "../supervisor/projects/index.js";

export type ProjectApiSupervisor = Readonly<{
  listProjects: () => Promise<SelectableCatalog>;
  connectProject: (repositoryUrl: string) => Promise<ConnectRepositoryResult>;
  getGitHubConnection: () => Promise<GitHubConnectionRecord>;
  refreshGitHubConnection: () => Promise<GitHubRefreshOutcome>;
  startGitHubAuthorization: () => Promise<GitHubAuthorizationOutcome>;
  completeGitHubAuthorization: () => Promise<GitHubAuthorizationOutcome>;
  disconnectProject: (projectId: string) => Promise<DisconnectRepositoryResult>;
}>;

function disconnectResponse(
  projectId: string,
  supervisor: ProjectApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.disconnectProject(projectId)).pipe(
    Effect.map((result) =>
      result.ok
        ? answer("POST /api/projects/:projectId/disconnect", result)
        : refusal({ ok: false, problem: result.problem }),
    ),
  );
}

type GitHubEndpoint =
  | "GET /api/github/connection"
  | "POST /api/github/connection/refresh"
  | "POST /api/github/authorization"
  | "POST /api/github/authorization/complete";

function recordResponse(endpoint: GitHubEndpoint, record: GitHubConnectionRecord): Response {
  return answer(endpoint, { ok: true, github: record.github, checkedAt: record.checkedAt });
}

function refreshResponse(
  supervisor: ProjectApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.refreshGitHubConnection()).pipe(
    Effect.map((outcome) =>
      outcome.ok
        ? recordResponse("POST /api/github/connection/refresh", outcome)
        : refusal({ ok: false, problem: { code: outcome.problem } }),
    ),
  );
}

const connectResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: ProjectApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, ConnectRequest);

  const result = yield* callSupervisor(() => supervisor.connectProject(body.repositoryUrl));

  if (!result.ok) {
    return refusal({ ok: false, problem: result.problem });
  }

  return answer("POST /api/projects/connect", result);
}, invalidRequestBody("invalid-connect-request"));

function authorizationResponse(
  endpoint: "POST /api/github/authorization" | "POST /api/github/authorization/complete",
  outcome: () => Promise<GitHubAuthorizationOutcome>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(outcome).pipe(
    Effect.map((result) =>
      result.ok
        ? recordResponse(endpoint, { github: result.status, checkedAt: result.checkedAt })
        : refusal({ ok: false, problem: { code: result.problem } }),
    ),
  );
}

export const PROJECT_HANDLERS: Handlers<
  ProjectApiSupervisor,
  | "GET /api/projects"
  | "POST /api/projects/connect"
  | "POST /api/projects/:projectId/disconnect"
  | "GET /api/github/connection"
  | "POST /api/github/connection/refresh"
  | "POST /api/github/authorization"
  | "POST /api/github/authorization/complete"
> = {
  "GET /api/projects": (_request, supervisor) =>
    callSupervisor(() => supervisor.listProjects()).pipe(
      Effect.map((projects) => answer("GET /api/projects", { ok: true, projects })),
    ),
  "POST /api/projects/connect": connectResponse,
  "POST /api/projects/:projectId/disconnect": (_request, projectId, supervisor) =>
    disconnectResponse(projectId, supervisor),
  "GET /api/github/connection": (_request, supervisor) =>
    callSupervisor(() => supervisor.getGitHubConnection()).pipe(
      Effect.map((record) => recordResponse("GET /api/github/connection", record)),
    ),
  "POST /api/github/connection/refresh": (_request, supervisor) => refreshResponse(supervisor),
  "POST /api/github/authorization": (_request, supervisor) =>
    authorizationResponse("POST /api/github/authorization", () =>
      supervisor.startGitHubAuthorization(),
    ),
  "POST /api/github/authorization/complete": (_request, supervisor) =>
    authorizationResponse("POST /api/github/authorization/complete", () =>
      supervisor.completeGitHubAuthorization(),
    ),
};
