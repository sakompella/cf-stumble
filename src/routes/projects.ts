import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";
import type { SelectableCatalog } from "../selectable-projects.js";
import type {
  ConnectRepositoryResult,
  DisconnectRepositoryResult,
  GitHubAuthorizationOutcome,
  GitHubAuthorizationProblem,
  GitHubConnectionRecord,
} from "../supervisor/projects/index.js";

export type ProjectApiSupervisor = Readonly<{
  listProjects: () => Promise<SelectableCatalog>;
  connectProject: (
    repositoryUrl: string,
    displayName: string | undefined,
  ) => Promise<ConnectRepositoryResult>;
  getGitHubConnection: () => Promise<GitHubConnectionRecord>;
  refreshGitHubConnection: () => Promise<GitHubConnectionRecord>;
  startGitHubAuthorization: () => Promise<GitHubAuthorizationOutcome>;
  completeGitHubAuthorization: () => Promise<GitHubAuthorizationOutcome>;
  disconnectProject: (projectId: string) => Promise<DisconnectRepositoryResult>;
}>;

const CONNECT_STATUS = {
  "invalid-repository-url": 400,
  "repository-not-accessible": 403,
  "repository-too-large": 413,
  "workspace-unavailable": 503,
  "tooling-missing": 503,
  "provisioning-failed": 503,
  "workspace-busy": 409,
} as const satisfies Record<string, number>;

const DISCONNECT_STATUS = {
  "invalid-project-id": 400,
  "unknown-project-id": 404,
  "run-active": 409,
  "workspace-busy": 409,
} as const satisfies Record<
  Extract<DisconnectRepositoryResult, { ok: false }>["problem"]["code"],
  number
>;

function disconnectResponse(
  projectId: string,
  supervisor: ProjectApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.disconnectProject(projectId)).pipe(
    Effect.map((result) =>
      result.ok
        ? Response.json(result)
        : Response.json(
            { ok: false, problem: result.problem },
            { status: DISCONNECT_STATUS[result.problem.code] },
          ),
    ),
  );
}

const AUTHORIZATION_STATUS = {
  "not-configured": 503,
  "provider-unavailable": 502,
  "no-pending-authorization": 409,
  "authorization-expired": 410,
  "authorization-denied": 403,
} as const satisfies Record<GitHubAuthorizationProblem, number>;

function recordResponse(record: GitHubConnectionRecord): Response {
  return Response.json({ ok: true, github: record.github, checkedAt: record.checkedAt });
}

function refreshResponse(
  supervisor: ProjectApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(() => supervisor.refreshGitHubConnection()).pipe(
    Effect.map((record) => recordResponse(record)),
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
    return Response.json(
      {
        ok: false,
        problem: result.problem,
        ...("github" in result && { github: result.github, checkedAt: result.checkedAt }),
      },
      { status: CONNECT_STATUS[result.problem.code] },
    );
  }

  return Response.json({
    ok: true,
    project: result.project,
    alreadyConnected: result.alreadyConnected,
    github: result.github,
    checkedAt: result.checkedAt,
  });
}, invalidRequestBody("invalid-connect-request"));

function authorizationResponse(
  outcome: () => Promise<GitHubAuthorizationOutcome>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(outcome).pipe(
    Effect.map((result) =>
      result.ok
        ? Response.json({ ok: true, github: result.status, checkedAt: result.checkedAt })
        : Response.json(
            { ok: false, problem: { code: result.problem } },
            { status: AUTHORIZATION_STATUS[result.problem] },
          ),
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
