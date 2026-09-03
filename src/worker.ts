import { authenticateAccessRequest, withoutAccessCredentials } from "./access/index.js";
import { ownerPageResponse, routeOwnerApiRequest } from "./routes/index.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { WorkspaceHost } from "./workspace/index.js";

export { Supervisor, WorkspaceHost };
export { WorkspaceProxy } from "@cloudflare/computer";
export { ModelRoute } from "./model-route.js";

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const access = await authenticateAccessRequest(request, env);
    if (!access.ok) {
      return new Response("Unauthorized", {
        status: access.reason === "invalid-configuration" ? 500 : 401,
      });
    }

    // A browser navigation to `GET /` receives the owner page. Every other request for that path,
    // including the Supervisor's own relayed startup check, keeps its current behavior.
    const page = ownerPageResponse(request);
    if (page !== undefined) {
      return page;
    }

    const supervisor = env.SUPERVISOR.getByName(access.supervisorName);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return routeOwnerApiRequest(request, supervisor);
    }

    return supervisor.fetch(withoutAccessCredentials(request));
  },
};
