/// <reference types="@cloudflare/workers-types" />

import type { Supervisor } from "./supervisor.js";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly LOADER: WorkerLoader;
      readonly MODULE_MAPS: R2Bucket;
      readonly SUPERVISOR: DurableObjectNamespace<Supervisor>;
    }
  }
}
