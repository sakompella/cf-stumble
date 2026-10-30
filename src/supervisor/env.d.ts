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
      /** The GitHub OAuth app the device authorization belongs to. Public configuration, stored as a secret so deploys keep it. */
      readonly GITHUB_OAUTH_CLIENT_ID?: string;
      /** The documented test and development credential. See `docs/agents/design/github-connection.md`. */
      readonly GH_TOKEN?: string;
      /** The model ChatGPT turns use. A declared plain variable (`cloudflare.config.ts`). */
      readonly CHATGPT_MODEL: string;
    }
  }
}
