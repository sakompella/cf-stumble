/**
 * A path is request data and can be anything a client typed, so the log names the pattern, never the
 * path; a path outside the owner API is `relay`.
 */

const FIXED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/health",
  "/api/status",
  "/api/projects",
  "/api/projects/connect",
  "/api/github/connection",
  "/api/github/connection/refresh",
  "/api/github/authorization",
  "/api/github/authorization/complete",
  "/api/chatgpt/connection",
  "/api/chatgpt/login",
  "/api/chatgpt/login/complete",
  "/api/chatgpt/disconnect",
  "/api/generations/submit",
  "/api/generations/activate",
  "/api/generations/rollback",
  "/api/workspace/reset",
]);

const PROJECT_ROUTE = /^\/api\/projects\/[^/]+(\/thread|\/thread\/fresh|\/turn|\/disconnect)$/u;

export function routePattern(pathname: string): string {
  if (FIXED_ROUTES.has(pathname)) return pathname;

  const projectRoute = PROJECT_ROUTE.exec(pathname)?.[1];

  if (projectRoute !== undefined) return `/api/projects/:projectId${projectRoute}`;

  return pathname.startsWith("/api/") ? "/api/unknown" : "relay";
}

/** The Supervisor resolves it against the catalog, so an unknown id is not guessed at here. */
export function projectIdFromPath(
  pathname: string,
  suffix: "/thread" | "/thread/fresh" | "/turn" | "/disconnect",
): string | undefined {
  const [, encodedProjectId, rest] = /^\/api\/projects\/([^/]+)(\/.+)$/u.exec(pathname) ?? [];

  if (encodedProjectId === undefined || rest !== suffix) return undefined;

  try {
    const projectId = decodeURIComponent(encodedProjectId);

    return projectId.length === 0 ? undefined : projectId;
  } catch {
    return undefined;
  }
}
