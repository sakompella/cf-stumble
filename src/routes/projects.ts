import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
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
  connectProject: (
    repositoryUrl: string,
    displayName: string | undefined,
  ) => Promise<ConnectRepositoryResult>;
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
      result.ok ? Response.json(result) : refusal({ ok: false, problem: result.problem }),
    ),
  );
}

function recordResponse(record: GitHubConnectionRecord): Response {
  return Response.json({ ok: true, github: record.github, checkedAt: record.checkedAt });
}

function refreshResponse(
  supervisor: ProjectApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.refreshGitHubConnection()).pipe(
    Effect.map((outcome) =>
      outcome.ok
        ? recordResponse(outcome)
        : refusal({ ok: false, problem: { code: outcome.problem } }),
    ),
  );
}

const ConnectBody = Schema.Struct({
  repositoryUrl: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

const connectResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: ProjectApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, ConnectBody);

  const result = yield* callSupervisor(() =>
    supervisor.connectProject(body.repositoryUrl, body.displayName),
  );

  if (!result.ok) {
    return refusal({ ok: false, problem: result.problem });
  }

  return Response.json({
    ok: true,
    project: result.project,
    alreadyConnected: result.alreadyConnected,
  });
}, invalidRequestBody("invalid-connect-request"));

function authorizationResponse(
  outcome: () => Promise<GitHubAuthorizationOutcome>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(outcome).pipe(
    Effect.map((result) =>
      result.ok
        ? Response.json({ ok: true, github: result.status, checkedAt: result.checkedAt })
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
      Effect.map((projects) => Response.json({ ok: true, projects })),
    ),
  "POST /api/projects/connect": connectResponse,
  "POST /api/projects/:projectId/disconnect": (_request, projectId, supervisor) =>
    disconnectResponse(projectId, supervisor),
  "GET /api/github/connection": (_request, supervisor) =>
    callSupervisor(() => supervisor.getGitHubConnection()).pipe(
      Effect.map((record) => recordResponse(record)),
    ),
  "POST /api/github/connection/refresh": (_request, supervisor) => refreshResponse(supervisor),
  "POST /api/github/authorization": (_request, supervisor) =>
    authorizationResponse(() => supervisor.startGitHubAuthorization()),
  "POST /api/github/authorization/complete": (_request, supervisor) =>
    authorizationResponse(() => supervisor.completeGitHubAuthorization()),
};
