// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Request JSON is parsed and validated at this HTTP boundary.
import { hasExactKeys, isRecord, jsonError, readJson } from "./json.js";
import type {
  ConnectRepositoryResult,
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
  listProjects: () => Promise<ProjectListView>;
  connectProject: (
    repositoryUrl: unknown,
    displayName: unknown,
  ) => Promise<ConnectRepositoryResult>;
  getGitHubConnection: () => Promise<GitHubConnectionStatus>;
  startGitHubAuthorization: (scope: VerifiedAccessScope) => Promise<GitHubAuthorizationOutcome>;
  completeGitHubAuthorization: (scope: VerifiedAccessScope) => Promise<GitHubAuthorizationOutcome>;
}>;

/**
 * A state-changing request has to come from cf-stumble's own page.
 *
 * Access sits in front of everything here, so a cross-site request cannot be a stranger's; it can
 * still be the owner's own browser driven by another site, which is what would let a page the
 * owner happens to visit start an authorization or connect a repository in their name. An absent
 * `Origin` is allowed because a same-origin `fetch` from the page and a command-line client both
 * omit it; a present one has to match.
 */
export function isCrossOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

const CONNECT_STATUS = {
  "invalid-repository-url": 400,
  "project-id-conflict": 409,
  "repository-not-accessible": 403,
  "workspace-unavailable": 503,
  "tooling-missing": 503,
  "provisioning-failed": 503,
} as const satisfies Record<string, number>;

const AUTHORIZATION_STATUS = {
  "not-configured": 503,
  "provider-unavailable": 502,
  "no-pending-authorization": 409,
  "not-the-initiating-owner": 403,
  "authorization-expired": 410,
  "authorization-denied": 403,
} as const satisfies Record<GitHubAuthorizationProblem, number>;

async function listResponse(supervisor: ProjectApiSupervisor): Promise<Response> {
  try {
    const view = await supervisor.listProjects();
    return Response.json({ ok: true, projects: view.projects, github: view.github });
  } catch {
    return jsonError(500, "internal-error");
  }
}

async function connectionResponse(supervisor: ProjectApiSupervisor): Promise<Response> {
  try {
    return Response.json({ ok: true, github: await supervisor.getGitHubConnection() });
  } catch {
    return jsonError(500, "internal-error");
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
): Promise<Response> | undefined {
  const pathname = new URL(request.url).pathname;
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/projects") {
    return listResponse(supervisor);
  }
  if (isGet && pathname === "/api/github/connection") {
    return connectionResponse(supervisor);
  }

  const mutation =
    pathname === "/api/projects/connect" ||
    pathname === "/api/github/authorization" ||
    pathname === "/api/github/authorization/complete";
  if (!isPost || !mutation) {
    return undefined;
  }
  if (isCrossOriginMutation(request)) {
    return Promise.resolve(jsonError(403, "cross-origin-request"));
  }

  if (pathname === "/api/projects/connect") {
    return connectResponse(request, supervisor);
  }
  return authorizationResponse(() =>
    pathname === "/api/github/authorization"
      ? supervisor.startGitHubAuthorization(scope)
      : supervisor.completeGitHubAuthorization(scope),
  );
}
