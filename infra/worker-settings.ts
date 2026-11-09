export const PRODUCTION_STAGE = "prod";

const PRODUCTION_WORKER = "cf-stumble";

export function workerName(stage: string): string {
  return stage === PRODUCTION_STAGE ? PRODUCTION_WORKER : `${PRODUCTION_WORKER}-${stage}`;
}

export const compatibility = {
  date: "2025-01-01",
  flags: ["enable_ctx_exports", "legacy_module_registry", "nodejs_compat"],
};

export const durableObjectClasses = {
  SUPERVISOR: "Supervisor",
  WORKSPACE_HOST: "WorkspaceHost",
} as const;

export const plainTextBindings = { CHATGPT_MODEL: "gpt-6.1-sol" } as const;

export const shellModulesAssetDirectory = "build/shell-assets";

export const SHELL_MODULES_FILE = "shell-modules.json";

export const WORKSPACE_CONTAINER_INSTANCE = "standard-3";

const WORKSPACE_OUTPUT_DIRECTORY = "/.cf-stumble/output";

const WORKSPACE_OUTPUT_MAX_LINES = 2_000;

const WORKSPACE_OUTPUT_MAX_BYTES = 64 * 1024;

const WORKSPACE_OUTPUT_KEEP = 50;

export const WORKSPACE_OUTPUT_OPTIONS = {
  maxLines: WORKSPACE_OUTPUT_MAX_LINES,
  maxBytes: WORKSPACE_OUTPUT_MAX_BYTES,
  dir: WORKSPACE_OUTPUT_DIRECTORY,
  keep: WORKSPACE_OUTPUT_KEEP,
} as const;

export const WORKSPACE_CONTAINER_MEMORY_MIB = 8192;

export const assetsConfig = { runWorkerFirst: true };

export const cache = { enabled: false };

export const workerEntrypoint = "src/worker.ts";

export const productionRoute = {
  pattern: "stumble.akompella.dev/*",
  zone: "akompella.dev",
} as const;

export function observability(isProduction: boolean) {
  return {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
    traces: { enabled: isProduction, headSamplingRate: 1, persist: true },
    issues: { enabled: true },
  };
}
