import * as Effect from "effect/Effect";
import { admitAccessRequest, withoutAccessCredentials } from "./access/index.js";
import type { AccessRefusalReason, AdmittedAccess } from "./access/index.js";
import { ownerPageResponse, routeOwnerApiRequest, routePattern } from "./routes/index.js";
import { logEvent, type LogLevel } from "./diagnostics.js";
import { runAtEntryPoint } from "./run-entry-point.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { WorkspaceHost } from "./workspace/index.js";

export { Supervisor, WorkspaceHost };

export { WorkspaceProxy } from "@cloudflare/computer";

export { ModelRoute } from "./model-route.js";

/**
 * What the boundary answers a refused request. A missing or unusable Access configuration is this
 * Worker's own fault and says nothing about the caller, so it answers 500 rather than 401. A
 * Cloudflare Access key-service failure is likewise this Worker's dependency failing, not a bad
 * credential, so it answers 503; the caller cannot tell it apart from `invalid-configuration` or
 * `invalid-signature` from the body alone, and the operator evidence lives in the log
 * `logRedactedCause` wrote when the key load failed, not in this response.
 */
function refusal(reason: AccessRefusalReason, request: Request, pathname: string): Response {
  const status =
    reason === "invalid-configuration" ? 500 : reason === "key-service-unavailable" ? 503 : 401;

  logEvent(refusalLevel(reason, status), "access.refused", {
    reason,
    route: routePattern(pathname),
    method: request.method,
    status,
  });

  return new Response("Unauthorized", { status });
}

/**
 * A request with no usable credential is ordinary internet traffic. A verified stranger is worth
 * a look, and a refusal this Worker caused itself is a fault.
 */
function refusalLevel(reason: string, status: number): LogLevel {
  if (status !== 401) return "error";

  return reason === "not-owner" ? "warn" : "info";
}

/** Re-wrap an owner response without consuming or buffering a streamed body. */
function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function ownerResponse(pathname: string, response: Response): Response {
  return pathname.startsWith("/api/") || pathname === "/health" ? noStore(response) : response;
}

function admittedRequest(
  request: Request,
  env: Cloudflare.Env,
  access: AdmittedAccess,
  pathname: string,
): Effect.Effect<Response> {
  // Liveness, answered by this Worker alone. Everything else that is not an owner API route is
  // relayed to the active generation, so before the first generation exists it answers 503
  // `no-active-generation`, and a deployment had no way to say "I am running" while that was
  // true. It stays behind Access, because the Worker refuses every route until Access is
  // configured and a liveness hole would be the one exception.
  if (request.method === "GET" && pathname === "/health") {
    return Effect.succeed(ownerResponse(pathname, Response.json({ ok: true })));
  }

  // A browser navigation to `GET /` receives the owner page, and a request for the page's current
  // script file receives that file. Every other request for `/`, including the Supervisor's own
  // relayed startup check, keeps its current behavior.
  const page = ownerPageResponse(request);

  if (page !== undefined) {
    return Effect.succeed(page);
  }

  const supervisor = env.SUPERVISOR.getByName(access.supervisorName);

  if (pathname.startsWith("/api/")) {
    return Effect.promise(() => routeOwnerApiRequest(request, supervisor, access.scope)).pipe(
      Effect.map((response) => ownerResponse(pathname, response)),
    );
  }

  // A relayed response is the generation's, body and all. A rejected relay is a defect, which
  // rejects the Worker's Promise as it always did.
  return Effect.promise(() => supervisor.fetch(withoutAccessCredentials(request)));
}

function ownerRequest(request: Request, env: Cloudflare.Env): Effect.Effect<Response> {
  const pathname = new URL(request.url).pathname;

  return admitAccessRequest(request, env).pipe(
    Effect.matchEffect({
      onFailure: (refused) =>
        Effect.succeed(ownerResponse(pathname, refusal(refused.reason, request, pathname))),
      onSuccess: (access) => admittedRequest(request, env, access, pathname),
    }),
  );
}

export default {
  // The one place the request program is interpreted (ADR-0045).
  fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return runAtEntryPoint(Effect.suspend(() => ownerRequest(request, env)));
  },
};
