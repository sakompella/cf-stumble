import type { BackendSetting, WorkspaceBackendChange } from "../backend-setting.js";
import type { WorkspaceHostNamespace, WorkspaceResetResult } from "../workspace/index.js";
import { tenantWorkspaceName } from "../workspace-names.js";

export type SupervisorWorkspaceReset =
  | WorkspaceResetResult
  | Readonly<{ ok: false; problem: Readonly<{ code: "run-active" }> }>;

export type { BackendSetting, WorkspaceBackendChange };

export type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly WORKSPACE_HOST: WorkspaceHostNamespace;
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GH_TOKEN?: string;
  readonly CHATGPT_MODEL: string;
  readonly CF_VERSION_METADATA?: Readonly<{ id: string }>;
};

export type SupervisorNames = Readonly<{ name: string; workspaceName: string }>;

export function supervisorNames(ctx: DurableObjectState): SupervisorNames {
  const name = ctx.id.name ?? ctx.id.toString();

  return { name, workspaceName: tenantWorkspaceName(name) };
}
