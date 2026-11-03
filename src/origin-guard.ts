import { logEvent } from "./diagnostics.js";
import { jsonError, routePattern } from "./routes/index.js";

const FETCH_SITES: ReadonlySet<string> = new Set([
  "same-origin",
  "same-site",
  "cross-site",
  "none",
]);

function originKind(origin: string | null, ownOrigin: string): string {
  if (origin === null) return "missing";

  if (origin === "null") return "null";

  return origin === ownOrigin ? "same" : "foreign";
}

export function crossOriginRefusal(request: Request): Response | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined;

  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  const crossOrigin =
    (origin !== null && origin !== url.origin) ||
    (fetchSite !== null && fetchSite !== "same-origin");

  if (!crossOrigin) return undefined;

  logEvent("warn", "route.cross-origin-refused", {
    route: routePattern(url.pathname),
    method: request.method,
    origin: originKind(origin, url.origin),
    fetchSite: fetchSite === null ? "missing" : FETCH_SITES.has(fetchSite) ? fetchSite : "other",
  });

  return jsonError(403, "cross-origin-request");
}
