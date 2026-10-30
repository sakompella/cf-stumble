import * as Effect from "effect/Effect";
import { ownerPageResponse, routeOwnerApiRequest } from "./routes/index.js";
import { runAtEntryPoint } from "./run-entry-point.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { WorkspaceHost } from "./workspace/index.js";

export { Supervisor, WorkspaceHost };

export { WorkspaceProxy } from "@cloudflare/computer";

export { ModelRoute } from "./model-route.js";

/** This Worker has one Supervisor, and every request reaches it by this name. */
const SUPERVISOR_NAME = "owner";

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

function ownerRequest(request: Request, env: Cloudflare.Env): Effect.Effect<Response> {
  const pathname = new URL(request.url).pathname;

  // Liveness, answered by this Worker alone. Everything else that is not an owner API route is
  // relayed to the active generation, so before the first generation exists it answers 503
  // `no-active-generation`, and a deployment had no other way to say "I am running".
  if (request.method === "GET" && pathname === "/health") {
    return Effect.succeed(noStore(Response.json({ ok: true })));
  }

  // A browser navigation to `GET /` receives the owner page, and a request for the page's current
  // script file receives that file. Every other request for `/`, including the Supervisor's own
  // relayed startup check, keeps its current behavior.
  const page = ownerPageResponse(request);

  if (page !== undefined) {
    return Effect.succeed(page);
  }

  const supervisor = env.SUPERVISOR.getByName(SUPERVISOR_NAME);

  if (pathname.startsWith("/api/")) {
    return routeOwnerApiRequest(request, supervisor).pipe(
      Effect.map((response) => noStore(response)),
    );
  }

  // A relayed response is the generation's, body and all. A rejected relay is a defect, which
  // rejects the Worker's Promise as it always did.
  return Effect.promise(() => supervisor.fetch(request));
}

export default {
  // The one place the request program is interpreted (ADR-0045).
  fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return runAtEntryPoint(Effect.suspend(() => ownerRequest(request, env)));
  },
};
