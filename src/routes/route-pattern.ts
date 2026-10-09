/**
 * The route a request reached, as the operational log names it. A path is request data: it can
 * carry a project id, and a path this Worker does not route can be anything a client typed. The
 * log therefore names the pattern, never the path, and a path outside the owner API is `relay`,
 * because the generation that serves decides what it means.
 */

/** Owner API routes whose path is fixed, so the path is its own pattern. */
const FIXED_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/health",
  "/api/status",
  "/api/projects",
  "/api/projects/connect",
  "/api/github/connection",
  "/api/github/authorization",
  "/api/github/authorization/complete",
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

/**
 * The project id a client named in `/api/projects/{id}{suffix}`, decoded but still a plain string.
 * The Supervisor resolves it against the catalog, so an id the catalog does not know comes back as
 * `unknown-project-id` rather than being guessed at here. An empty or undecodable id is no id.
 */
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
