/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    readonly LOADER: WorkerLoader;
    readonly SUPERVISOR: DurableObjectNamespace;
  }
}
