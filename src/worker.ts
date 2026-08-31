import { Supervisor } from "./supervisor/supervisor.js";

export { Supervisor };

export default {
  fetch(request: Request, env: { SUPERVISOR: DurableObjectNamespace }): Promise<Response> {
    return env.SUPERVISOR.getByName("facet-spike").fetch(request);
  },
};
