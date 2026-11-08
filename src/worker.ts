import * as Effect from "effect/Effect";
import { ownerPageResponse, routeOrbRequest, routeOwnerApiRequest } from "./routes/index.js";
import { runAtEntryPoint } from "./run-entry-point.js";
import { ownerGateRefusal } from "./owner-gate.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { IsolateWorkspaceGate, WorkspaceHost } from "./workspace/index.js";
import { tenantWorkspaceName } from "./workspace-names.js";

export { IsolateWorkspaceGate, Supervisor, WorkspaceHost };

export { WorkspaceProxy } from "@cloudflare/computer";

export { ModelRoute } from "./model-route.js";

export { StartupCheckModel } from "./startup-check-model.js";

const SUPERVISOR_NAME = "owner";

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

  if (request.method === "GET" && pathname === "/health") {
    return Effect.succeed(noStore(Response.json({ ok: true })));
  }

  const orb = routeOrbRequest(request, () =>
    env.WORKSPACE_HOST.getByName(tenantWorkspaceName(SUPERVISOR_NAME)),
  );

  if (orb !== undefined) {
    return orb;
  }

  const page = ownerPageResponse(request);

  if (page !== undefined) {
    return Effect.succeed(page);
  }

  return routeOwnerApiRequest(request, env.SUPERVISOR.getByName(SUPERVISOR_NAME)).pipe(
    Effect.map((response) => noStore(response)),
  );
}

function gatedRequest(request: Request, env: Cloudflare.Env): Effect.Effect<Response> {
  return ownerGateRefusal(request, env.OWNER_PASSWORD).pipe(
    Effect.flatMap((refusal) =>
      refusal === undefined ? ownerRequest(request, env) : Effect.succeed(noStore(refusal)),
    ),
  );
}

export default {
  fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return runAtEntryPoint(Effect.suspend(() => gatedRequest(request, env)));
  },
};
