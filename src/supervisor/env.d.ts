/// <reference types="@cloudflare/workers-types" />

import type * as WorkerModule from "../worker.js";
import type { Supervisor } from "./supervisor.js";
import type { WorkspaceHost } from "../workspace/index.js";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      readonly mainModule: typeof WorkerModule;
    }

    interface Env {
      readonly LOADER: WorkerLoader;
      readonly AI: Ai;
      readonly MODULE_MAPS: R2Bucket;
      readonly SUPERVISOR: DurableObjectNamespace<Supervisor>;
      readonly WORKSPACE_HOST: DurableObjectNamespace<WorkspaceHost>;
      readonly CF_ACCESS_TEAM_DOMAIN: string;
      readonly CF_ACCESS_AUD: string;
    }
  }
}
