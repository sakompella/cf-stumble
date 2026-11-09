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
      readonly ASSETS: Fetcher;
      readonly AI: Ai;
      readonly MODULE_MAPS: R2Bucket;
      readonly ARTIFACTS?: Artifacts;
      readonly SUPERVISOR: DurableObjectNamespace<Supervisor>;
      readonly WORKSPACE_HOST: DurableObjectNamespace<WorkspaceHost>;
      readonly GITHUB_OAUTH_CLIENT_ID?: string;
      readonly GH_TOKEN?: string;
      readonly OWNER_PASSWORD?: string;
      readonly CHATGPT_MODEL: string;
    }
  }
}
