// oxlint-disable anti-slop/no-unknown-parameters -- The Supervisor RPC methods take request data as `unknown` and parse it themselves.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";
import { logRedactedCause, type RequestId } from "../diagnostics.js";
import { projectIdFromPath } from "./route-pattern.js";
import { markDegraded } from "./route-settled.js";
import type {
  ConnectRepositoryResult,
  DisconnectRepositoryResult,
  GitHubAuthorizationOutcome,
  GitHubAuthorizationProblem,
  GitHubConnectionStatus,
  ProjectListView,
  VerifiedAccessScope,
} from "../supervisor/projects/index.js";

/**
 * The project surface the page reads and writes: list the tenant's connected repositories, connect
 * another one, and drive the GitHub authorization.
 *
 * Two things never arrive in a request here. The tenant, because the Worker resolved it from the
 * verified token before this module ran and passes the scope as an argument; a body field named
 * `identity` or `tenant` is refused at the boundary and is inert here in any case. And a
 * credential, because there is no field for one: the owner authorizes at GitHub's page, and the
 * token goes from GitHub to the workspace without passing through a browser.
 *
 * Every response is built from named fields of a Supervisor result, so no internal error text
 * reaches a client and no status shape can gain a token by accident.
 */
export type ProjectApiSupervisor = Readonly<{
  listProjects: (requestId?: RequestId) => Promise<ProjectListView>;
  connectProject: (
    repositoryUrl: unknown,
    displayName: unknown,
  ) => Promise<ConnectRepositoryResult>;
  getGitHubConnection: (requestId?: RequestId) => Promise<GitHubConnectionStatus>;
  startGitHubAuthorization: (scope: VerifiedAccessScope) => Promise<GitHubAuthorizationOutcome>;
  completeGitHubAuthorization: (scope: VerifiedAccessScope) => Promise<GitHubAuthorizationOutcome>;
  disconnectProject: (projectId: unknown) => Promise<DisconnectRepositoryResult>;
}>;

const CONNECT_STATUS = {
  "invalid-repository-url": 400,
  "project-id-conflict": 409,
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
  "harness-project": 400,
  "turn-active": 409,
  "workspace-busy": 409,
} as const;

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
  "not-the-initiating-owner": 403,
  "authorization-expired": 410,
  "authorization-denied": 403,
} as const satisfies Record<GitHubAuthorizationProblem, number>;

/** A connection that needs the owner's attention is still a 200, so the log marks it. */
function reportingGitHub(response: Response, github: GitHubConnectionStatus): Response {
  return github.state === "reconnect-required" ? markDegraded(response) : response;
}

/**
 * The list and the connection status read the workspace. When that read fails, the owner sees the
 * workspace as unavailable, and the cause goes to the operator log redacted.
 */
function workspaceUnavailable(
  operation: "list" | "connection",
): (failure: SupervisorCallFailed) => Effect.Effect<Response> {
  return (failure) =>
    Effect.sync(() => {
      logRedactedCause(`routes.projects.${operation}: workspace-unavailable`, failure.cause);

      return jsonError(503, "internal-error");
    });
}

function listResponse(
  supervisor: ProjectApiSupervisor,
  requestId: RequestId | undefined,
): Effect.Effect<Response> {
  return callSupervisor(() => supervisor.listProjects(requestId)).pipe(
    Effect.map((view) =>
      reportingGitHub(
        Response.json({ ok: true, projects: view.projects, github: view.github }),
        view.github,
      ),
    ),
    Effect.catchTag("SupervisorCallFailed", workspaceUnavailable("list")),
  );
}

function connectionResponse(
  supervisor: ProjectApiSupervisor,
  requestId: RequestId | undefined,
): Effect.Effect<Response> {
  return callSupervisor(() => supervisor.getGitHubConnection(requestId)).pipe(
    Effect.map((github) => reportingGitHub(Response.json({ ok: true, github }), github)),
    Effect.catchTag("SupervisorCallFailed", workspaceUnavailable("connection")),
  );
}

/** The connect body: a repository URL, and optionally a name to show it under. Nothing else. */
const ConnectBody = Schema.Struct({
  repositoryUrl: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
});

const connectResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: ProjectApiSupervisor) {
    const body = yield* decodeRequestBody(request, ConnectBody);

    const result = yield* callSupervisor(() =>
      supervisor.connectProject(body.repositoryUrl, body.displayName),
    );

    if (!result.ok) {
      return Response.json(
        {
          ok: false,
          problem: result.problem,
          ...("github" in result && { github: result.github }),
        },
        { status: CONNECT_STATUS[result.problem.code] },
      );
    }

    return Response.json({
      ok: true,
      project: result.project,
      alreadyConnected: result.alreadyConnected,
      github: result.github,
    });
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-connect-request")),
  ),
);

function authorizationResponse(
  outcome: () => Promise<GitHubAuthorizationOutcome>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(outcome).pipe(
    Effect.map((result) =>
      result.ok
        ? Response.json({ ok: true, github: result.status })
        : Response.json(
            { ok: false, problem: { code: result.problem } },
            { status: AUTHORIZATION_STATUS[result.problem] },
          ),
    ),
  );
}

/**
 * Route one project or authorization request, or answer `undefined` so the owner API can try its
 * other routes. The scope is the verified one; it reaches the Supervisor as an argument and never
 * as request data.
 */
export function routeProjectApiRequest(
  request: Request,
  supervisor: ProjectApiSupervisor,
  scope: VerifiedAccessScope,
  requestId?: RequestId,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  const pathname = new URL(request.url).pathname;
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/projects") {
    return listResponse(supervisor, requestId);
  }

  if (isGet && pathname === "/api/github/connection") {
    return connectionResponse(supervisor, requestId);
  }

  const disconnectedProjectId = projectIdFromPath(pathname, "/disconnect");

  const mutation =
    pathname === "/api/projects/connect" ||
    pathname === "/api/github/authorization" ||
    pathname === "/api/github/authorization/complete" ||
    disconnectedProjectId !== undefined;

  if (!isPost || !mutation) {
    return undefined;
  }

  if (pathname === "/api/projects/connect") {
    return connectResponse(request, supervisor);
  }

  if (disconnectedProjectId !== undefined) {
    return disconnectResponse(disconnectedProjectId, supervisor);
  }

  return authorizationResponse(() =>
    pathname === "/api/github/authorization"
      ? supervisor.startGitHubAuthorization(scope)
      : supervisor.completeGitHubAuthorization(scope),
  );
}
