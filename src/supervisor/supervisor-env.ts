import type { BuildWorkspaceNamespace } from "./artifacts/index.js";
import type {
  CredentialWorkspaceNamespace,
  ProjectRemovalWorkspaceNamespace,
  ProjectWorkspaceNamespace,
  ProvisionWorkspaceNamespace,
} from "./projects/index.js";
import type { BackendSetting, WorkspaceBackendChange } from "../backend-setting.js";
import type {
  HarnessProvisionWorkspaceNamespace,
  WorkspaceResetResult,
} from "../workspace/index.js";
import { tenantWorkspaceName } from "../workspace-names.js";

export type ResetWorkspaceHost = Readonly<{ reset(): Promise<WorkspaceResetResult> }>;

export type ResetWorkspaceNamespace = Readonly<{ getByName(name: string): ResetWorkspaceHost }>;

export type SupervisorWorkspaceReset =
  | WorkspaceResetResult
  | Readonly<{ ok: false; problem: Readonly<{ code: "run-active" }> }>;

export type { BackendSetting, WorkspaceBackendChange };

export type BackendWorkspaceHost = Readonly<{
  backend(): Promise<BackendSetting>;
  setBackend(setting: BackendSetting): Promise<WorkspaceBackendChange>;
}>;

type HostOf<Namespace extends Readonly<{ getByName(name: string): object }>> = ReturnType<
  Namespace["getByName"]
>;

export type SupervisorWorkspaceHost = HostOf<BuildWorkspaceNamespace> &
  HostOf<ProjectWorkspaceNamespace> &
  HostOf<CredentialWorkspaceNamespace> &
  HostOf<ProvisionWorkspaceNamespace> &
  HostOf<ProjectRemovalWorkspaceNamespace> &
  HostOf<HarnessProvisionWorkspaceNamespace> &
  ResetWorkspaceHost &
  BackendWorkspaceHost;

export type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly WORKSPACE_HOST: Readonly<{ getByName(name: string): SupervisorWorkspaceHost }>;
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
