import { authenticateAccessRequest, withoutAccessCredentials } from "./access/index.js";
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

    return env.SUPERVISOR.getByName(access.supervisorName).fetch(withoutAccessCredentials(request));
  },
};
