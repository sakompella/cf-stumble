// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Request JSON is parsed and validated at this HTTP boundary.
import { hasExactKeys, isRecord, jsonError, readJson } from "./json.js";
import { logEvent, logRedactedCause, type RequestId } from "../diagnostics.js";
import { routePattern } from "./route-pattern.js";
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

/**
 * A state-changing request has to come from cf-stumble's own page.
 *
 * Access sits in front of everything here, so a cross-site request cannot be a stranger's; it can
 * still be the owner's own browser driven by another site, which is what would let a page the
 * owner happens to visit start an authorization or connect a repository in their name. The
 * browser must send an `Origin` that exactly matches the request URL's origin. A missing value,
 * `null`, and every other value are refused.
 *
 * Every caller refuses the request when this answers true, so the refusal is logged here, once:
 * the route pattern and which kind of origin it was, never the origin itself.
 */
export function isCrossOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const crossOrigin = origin === null || origin !== url.origin;

  if (crossOrigin) {
    logEvent("warn", "route.cross-origin-refused", {
      route: routePattern(url.pathname),
      method: request.method,
      origin: origin === null ? "missing" : origin === "null" ? "null" : "foreign",
    });
  }

  return crossOrigin;
}

const CONNECT_STATUS = {
  "invalid-repository-url": 400,
  "project-id-conflict": 409,
  "repository-not-accessible": 403,
  "repository-too-large": 413,
  "workspace-unavailable": 503,
  "tooling-missing": 503,
  "provisioning-failed": 503,
} as const satisfies Record<string, number>;

const DISCONNECT_STATUS = {
  "invalid-project-id": 400,
  "unknown-project-id": 404,
  "harness-project": 400,
  "turn-active": 409,
} as const;

function disconnectProjectId(pathname: string): string | undefined {
  const encoded = /^\/api\/projects\/([^/]+)\/disconnect$/u.exec(pathname)?.[1];

  if (encoded === undefined) return undefined;

  try {
    const projectId = decodeURIComponent(encoded);

    return projectId.length === 0 ? undefined : projectId;
  } catch {
    return undefined;
  }
}

async function disconnectResponse(
  projectId: string,
  supervisor: ProjectApiSupervisor,
): Promise<Response> {
  try {
    const result = await supervisor.disconnectProject(projectId);

    return result.ok
      ? Response.json(result)
      : Response.json(
          { ok: false, problem: result.problem },
          { status: DISCONNECT_STATUS[result.problem.code] },
        );
  } catch (cause) {
    logRedactedCause("routes.projects.disconnect: internal-error", cause);

    return jsonError(500, "internal-error");
  }
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

async function listResponse(
  supervisor: ProjectApiSupervisor,
  requestId: RequestId | undefined,
): Promise<Response> {
  try {
    const view = await supervisor.listProjects(requestId);

    return reportingGitHub(
      Response.json({ ok: true, projects: view.projects, github: view.github }),
      view.github,
    );
  } catch (cause) {
    logRedactedCause("routes.projects.list: workspace-unavailable", cause);

    return jsonError(503, "internal-error");
  }
}

async function connectionResponse(
  supervisor: ProjectApiSupervisor,
  requestId: RequestId | undefined,
): Promise<Response> {
  try {
    const github = await supervisor.getGitHubConnection(requestId);

    return reportingGitHub(Response.json({ ok: true, github }), github);
  } catch (cause) {
    logRedactedCause("routes.projects.connection: workspace-unavailable", cause);

    return jsonError(503, "internal-error");
  }
}

/** The connect body: a repository URL, and optionally a name to show it under. Nothing else. */
function connectRequest(
  value: unknown,
): Readonly<{ repositoryUrl: string; displayName: string | undefined }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const named = hasExactKeys(value, ["repositoryUrl"]);
  const withName = hasExactKeys(value, ["displayName", "repositoryUrl"]);

  if ((!named && !withName) || typeof value.repositoryUrl !== "string") {
    return undefined;
  }

  if (withName && typeof value.displayName !== "string") {
    return undefined;
  }

  return {
    repositoryUrl: value.repositoryUrl,
    displayName: withName && typeof value.displayName === "string" ? value.displayName : void 0,
  };
}

async function connectResponse(
  request: Request,
  supervisor: ProjectApiSupervisor,
): Promise<Response> {
  const body = connectRequest(await readJson(request));

  if (body === undefined) {
    return jsonError(400, "invalid-connect-request");
  }

  try {
    const result = await supervisor.connectProject(body.repositoryUrl, body.displayName);

    if (!result.ok) {
      return Response.json(
        { ok: false, problem: result.problem, github: result.github },
        { status: CONNECT_STATUS[result.problem.code] },
      );
    }

    return Response.json({
      ok: true,
      project: result.project,
      alreadyConnected: result.alreadyConnected,
      github: result.github,
    });
  } catch {
    return jsonError(500, "internal-error");
  }
}

async function authorizationResponse(
  outcome: () => Promise<GitHubAuthorizationOutcome>,
): Promise<Response> {
  try {
    const result = await outcome();

    return result.ok
      ? Response.json({ ok: true, github: result.status })
      : Response.json(
          { ok: false, problem: { code: result.problem } },
          { status: AUTHORIZATION_STATUS[result.problem] },
        );
  } catch {
    return jsonError(500, "internal-error");
  }
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
): Promise<Response> | undefined {
  const pathname = new URL(request.url).pathname;
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/projects") {
    return listResponse(supervisor, requestId);
  }

  if (isGet && pathname === "/api/github/connection") {
    return connectionResponse(supervisor, requestId);
  }

  const disconnectedProjectId = disconnectProjectId(pathname);

  const mutation =
    pathname === "/api/projects/connect" ||
    pathname === "/api/github/authorization" ||
    pathname === "/api/github/authorization/complete" ||
    disconnectedProjectId !== undefined;

  if (!isPost || !mutation) {
    return undefined;
  }

  if (isCrossOriginMutation(request)) {
    return Promise.resolve(jsonError(403, "cross-origin-request"));
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
