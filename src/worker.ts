import * as Effect from "effect/Effect";
import { ownerPageResponse, routeOwnerApiRequest } from "./routes/index.js";
import { runAtEntryPoint } from "./run-entry-point.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { WorkspaceHost } from "./workspace/index.js";

export { Supervisor, WorkspaceHost };

export { WorkspaceProxy } from "@cloudflare/computer";

export { ModelRoute } from "./model-route.js";

const SUPERVISOR_NAME = "owner";

/** Re-wrap without consuming or buffering a streamed body. */
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

  // Answered by this Worker alone, since before the first generation exists relayed requests answer
  // 503.
  if (request.method === "GET" && pathname === "/health") {
    return Effect.succeed(noStore(Response.json({ ok: true })));
  }

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

  return Effect.promise(() => supervisor.fetch(request));
}

export default {
  fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return runAtEntryPoint(Effect.suspend(() => ownerRequest(request, env)));
  },
};
