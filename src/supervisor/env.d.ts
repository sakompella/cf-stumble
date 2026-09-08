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
      readonly SUPERVISOR: DurableObjectNamespace<Supervisor>;
      readonly WORKSPACE_HOST: DurableObjectNamespace<WorkspaceHost>;
      readonly CF_ACCESS_TEAM_DOMAIN: string;
      readonly CF_ACCESS_AUD: string;
      readonly CF_ACCESS_OWNER_SUB: string;
      /** The GitHub OAuth app the device authorization belongs to. Public configuration. */
      readonly GITHUB_OAUTH_CLIENT_ID?: string;
      /** The documented test and development credential. See `docs/agents/design/github-connection.md`. */
      readonly GH_TOKEN?: string;
    }
  }
}
