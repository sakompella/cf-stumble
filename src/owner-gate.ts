import * as Effect from "effect/Effect";
import { logEvent } from "./diagnostics.js";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH } from "./orb-protocol.js";
import { jsonError, routePattern } from "./routes/index.js";

const OWNER_USERNAME = "aditya";

const BASIC_CHALLENGE = 'Basic realm="cf-stumble", charset="UTF-8"';

type ExemptRoute = Readonly<{ method: string; pathname: string }>;

const EXEMPT_ROUTES: readonly ExemptRoute[] = [
  { method: "GET", pathname: "/health" },
  { method: "GET", pathname: ORB_PROVIDER_PATH },
  { method: "GET", pathname: ORB_COMPUTERD_PATH },
];

const FETCH_SITES: ReadonlySet<string> = new Set([
  "same-origin",
  "same-site",
  "cross-site",
  "none",
]);

function isExemptRoute(request: Request): boolean {
  const { pathname } = new URL(request.url);

  return EXEMPT_ROUTES.some(
    (route) => route.method === request.method && route.pathname === pathname,
  );
}

function presentedCredential(authorization: string | null): Uint8Array | undefined {
  const token = /^Basic +(\S+)$/iu.exec(authorization ?? "")?.[1];

  if (token === undefined) return undefined;

  try {
    return Uint8Array.from(atob(token), (char) => char.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

async function isOwnerCredential(password: string, authorization: string | null): Promise<boolean> {
  const presented = presentedCredential(authorization);

  if (presented === undefined) return false;

  const [expectedDigest, presentedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${OWNER_USERNAME}:${password}`)),
    crypto.subtle.digest("SHA-256", presented),
  ]);

  return crypto.subtle.timingSafeEqual(expectedDigest, presentedDigest);
}

function originKind(origin: string | null, ownOrigin: string): string {
  if (origin === null) return "missing";

  if (origin === "null") return "null";

  return origin === ownOrigin ? "same" : "foreign";
}

function isCrossOriginMutation(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;

  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  const crossOrigin =
    (origin !== null && origin !== url.origin) ||
    (fetchSite !== null && fetchSite !== "same-origin");

  if (crossOrigin) {
    logEvent("warn", "route.cross-origin-refused", {
      route: routePattern(url.pathname),
      method: request.method,
      origin: originKind(origin, url.origin),
      fetchSite: fetchSite === null ? "missing" : FETCH_SITES.has(fetchSite) ? fetchSite : "other",
    });
  }

  return crossOrigin;
}

export function ownerGateRefusal(
  request: Request,
  password: string | undefined,
): Effect.Effect<Response | undefined> {
  return Effect.gen(function* () {
    if (isExemptRoute(request)) return undefined;

    if (password === undefined || password === "") {
      return new Response("The OWNER_PASSWORD secret is not set on this Worker.\n", {
        status: 503,
      });
    }

    const authorized = yield* Effect.promise(() =>
      isOwnerCredential(password, request.headers.get("authorization")),
    );

    if (!authorized) {
      return new Response("Unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": BASIC_CHALLENGE },
      });
    }

    return isCrossOriginMutation(request) ? jsonError(403, "cross-origin-request") : undefined;
  });
}
