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
