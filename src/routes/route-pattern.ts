import { endpointPattern } from "../api/endpoints.js";

const PAGE_ROUTES: ReadonlySet<string> = new Set(["/", "/health"]);

export function routePattern(pathname: string): string {
  if (PAGE_ROUTES.has(pathname)) return pathname;

  const pattern = endpointPattern(pathname);

  if (pattern !== undefined) return pattern;

  return pathname.startsWith("/api/") ? "/api/unknown" : "unknown";
}
