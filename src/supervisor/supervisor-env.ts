import type { BuildWorkspaceNamespace } from "./artifacts/index.js";
import type {
  CredentialWorkspaceNamespace,
  ProjectRemovalWorkspaceNamespace,
  ProjectWorkspaceNamespace,
  ProvisionWorkspaceNamespace,
} from "./projects/index.js";
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

type HostOf<Namespace extends Readonly<{ getByName(name: string): object }>> = ReturnType<
  Namespace["getByName"]
>;

export type SupervisorWorkspaceHost = HostOf<BuildWorkspaceNamespace> &
  HostOf<ProjectWorkspaceNamespace> &
  HostOf<CredentialWorkspaceNamespace> &
  HostOf<ProvisionWorkspaceNamespace> &
  HostOf<ProjectRemovalWorkspaceNamespace> &
  HostOf<HarnessProvisionWorkspaceNamespace> &
  ResetWorkspaceHost;

export type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly WORKSPACE_HOST: Readonly<{ getByName(name: string): SupervisorWorkspaceHost }>;
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  readonly GH_TOKEN?: string;
  readonly CHATGPT_MODEL: string;
};

export type SupervisorNames = Readonly<{ name: string; workspaceName: string }>;

export function supervisorNames(ctx: DurableObjectState): SupervisorNames {
  const name = ctx.id.name ?? ctx.id.toString();

  return { name, workspaceName: tenantWorkspaceName(name) };
}
