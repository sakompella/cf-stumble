import { execFileSync } from "node:child_process";

export const PRODUCTION_STAGE = "prod";

const PRODUCTION_WORKER = "cf-stumble";

export function workerName(stage: string): string {
  return stage === PRODUCTION_STAGE ? PRODUCTION_WORKER : `${PRODUCTION_WORKER}-${stage}`;
}

export const compatibility = {
  date: "2025-01-01",
  flags: ["enable_ctx_exports", "nodejs_compat"],
};

export const durableObjectClasses = {
  SUPERVISOR: "Supervisor",
  WORKSPACE_HOST: "WorkspaceHost",
} as const;

export const plainTextBindings = { CHATGPT_MODEL: "gpt-6.1-sol" } as const;

export const shellModulesAssetDirectory = "build/shell-assets";

export const workerEntrypoint = "src/worker.ts";

export const productionRoute = {
  pattern: "stumble.akompella.dev/*",
  zone: "akompella.dev",
} as const;

const imageTagScript = new URL("../containers/image-tag.sh", import.meta.url);

export const workspaceImage = `ghcr.io/sakompella/cf-stumble-workspace:${execFileSync(imageTagScript.pathname, { encoding: "utf8" }).trim()}`;

export function observability(isProduction: boolean) {
  return {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
    traces: { enabled: isProduction, headSamplingRate: 1, persist: true },
    issues: { enabled: true },
  };
}
