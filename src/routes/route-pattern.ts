export type RouteClass = "record-only" | "workspace";

const PAGE_ROUTES: ReadonlySet<string> = new Set(["/", "/health"]);

const API_ROUTES: ReadonlyMap<string, RouteClass> = new Map([
  ["/api/status", "record-only"],
  ["/api/projects", "record-only"],
  ["/api/github/connection", "record-only"],
  ["/api/chatgpt/connection", "record-only"],
  ["/api/projects/connect", "workspace"],
  ["/api/github/connection/refresh", "workspace"],
  ["/api/github/authorization", "workspace"],
  ["/api/github/authorization/complete", "workspace"],
  ["/api/chatgpt/login", "record-only"],
  ["/api/chatgpt/login/complete", "record-only"],
  ["/api/chatgpt/disconnect", "record-only"],
  ["/api/generations/submit", "workspace"],
  ["/api/generations/activate", "workspace"],
  ["/api/generations/rollback", "workspace"],
  ["/api/workspace/reset", "workspace"],
]);

const PROJECT_ROUTE_SUFFIXES = [
  "/messages",
  "/events",
  "/abort",
  "/thread/fresh",
  "/disconnect",
] as const;

export type ProjectRouteSuffix = (typeof PROJECT_ROUTE_SUFFIXES)[number];

export function routePattern(pathname: string): string {
  if (PAGE_ROUTES.has(pathname) || API_ROUTES.has(pathname)) return pathname;

  const projectRoute = /^\/api\/projects\/[^/]+(\/.+)$/u.exec(pathname)?.[1];
  const suffix = PROJECT_ROUTE_SUFFIXES.find((known) => known === projectRoute);

  if (suffix !== undefined) return `/api/projects/:projectId${suffix}`;

  return pathname.startsWith("/api/") ? "/api/unknown" : "unknown";
}

export function routeClass(pattern: string): RouteClass {
  const fixed = API_ROUTES.get(pattern);

  if (fixed !== undefined) return fixed;

  return PROJECT_ROUTE_SUFFIXES.some((suffix) => pattern === `/api/projects/:projectId${suffix}`)
    ? "workspace"
    : "record-only";
}

export function projectIdFromPath(
  pathname: string,
  suffix: ProjectRouteSuffix,
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
