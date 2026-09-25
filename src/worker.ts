import { authenticateAccessRequest, withoutAccessCredentials } from "./access/index.js";
import type { AccessRequestResult } from "./access/index.js";
import { ownerPageResponse, routeOwnerApiRequest } from "./routes/index.js";
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
function refusal(reason: Exclude<AccessRequestResult, { ok: true }>["reason"]): Response {
  const status =
    reason === "invalid-configuration" ? 500 : reason === "key-service-unavailable" ? 503 : 401;

  return new Response("Unauthorized", { status });
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

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const access = await authenticateAccessRequest(request, env);

    if (!access.ok) {
      return ownerResponse(pathname, refusal(access.reason));
    }

    // Liveness, answered by this Worker alone. Everything else that is not an owner API route is
    // relayed to the active generation, so before the first generation exists it answers 503
    // `no-active-generation`, and a deployment had no way to say "I am running" while that was
    // true. It stays behind Access, because the Worker refuses every route until Access is
    // configured and a liveness hole would be the one exception.
    if (request.method === "GET" && pathname === "/health") {
      return ownerResponse(pathname, Response.json({ ok: true }));
    }

    // A browser navigation to `GET /` receives the owner page. Every other request for that path,
    // including the Supervisor's own relayed startup check, keeps its current behavior.
    const page = ownerPageResponse(request);

    if (page !== undefined) {
      return page;
    }

    const supervisor = env.SUPERVISOR.getByName(access.supervisorName);

    if (pathname.startsWith("/api/")) {
      return ownerResponse(pathname, await routeOwnerApiRequest(request, supervisor, access.scope));
    }

    return supervisor.fetch(withoutAccessCredentials(request));
  },
};
