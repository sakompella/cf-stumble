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

const PROJECT_ROUTE_SUFFIXES = [
  "/messages",
  "/events",
  "/abort",
  "/thread/fresh",
  "/disconnect",
] as const;

export type ProjectRouteSuffix = (typeof PROJECT_ROUTE_SUFFIXES)[number];

export function routePattern(pathname: string): string {
  if (FIXED_ROUTES.has(pathname)) return pathname;

  const projectRoute = /^\/api\/projects\/[^/]+(\/.+)$/u.exec(pathname)?.[1];
  const suffix = PROJECT_ROUTE_SUFFIXES.find((known) => known === projectRoute);

  if (suffix !== undefined) return `/api/projects/:projectId${suffix}`;

  return pathname.startsWith("/api/") ? "/api/unknown" : "relay";
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
