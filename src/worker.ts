import { authenticateAccessRequest, withoutAccessCredentials } from "./access/index.js";
import { routeOwnerApiRequest } from "./routes/index.js";
import { Supervisor } from "./supervisor/supervisor.js";

export { Supervisor };
export { ModelRoute } from "./model-route.js";

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const access = await authenticateAccessRequest(request, env);
    if (!access.ok) {
      return new Response("Unauthorized", {
        status: access.reason === "invalid-configuration" ? 500 : 401,
      });
    }

    const supervisor = env.SUPERVISOR.getByName(access.supervisorName);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return routeOwnerApiRequest(request, supervisor);
    }

    return supervisor.fetch(withoutAccessCredentials(request));
  },
};
