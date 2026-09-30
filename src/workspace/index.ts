export { ComputerWorkspaceOperations, type CommandSync } from "./computer-operations.js";

export { type WorkspaceFailure, type WorkspacePlan, type WorkspaceResult } from "./decisions.js";

export {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "./executor.js";

export {
  parseHarnessBuildRequest,
  planHarnessBuildRequest,
  type ParsedHarnessBuildRequest,
} from "./harness-build.js";

export {
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type ParsedProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "./project-provision.js";

export {
  checkRepositoryAccess,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialInstallation,
  type CredentialWorkspaceHost,
  type CredentialWorkspaceNamespace,
  type InstallWorkspaceCredentialInput,
  type RepositoryAccessInput,
  type WorkspaceCredentialInput,
  type WorkspaceCredentialProblem,
} from "./credential-access.js";

export {
  executeGitHubCredentialRequest,
  parseGitHubCredentialRequest,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
} from "./github-credential.js";

export {
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
  waitForWorkspaceProvision,
  clearWorkspaceProvision,
  PROVISION_RPC_TIMEOUT_MS,
  PROVISION_STALE_AFTER_MS,
  PROVISION_STALE_MARGIN_MS,
  type HarnessProvisionProblem,
  type HarnessProvisionStepName,
  type HarnessProvisionWorkspaceHost,
  type HarnessProvisionWorkspaceNamespace,
  type ProvisionHarnessWorkspaceInput,
  type ProvisionedHarnessWorkspace,
  type ProjectProvisionProblem,
  type ProvisionedProjectWorkspace,
  type ProvisionProjectWorkspaceInput,
  type ProvisionWorkspaceHost,
  type ProvisionWorkspaceNamespace,
  type ProjectRemovalWorkspaceNamespace,
} from "./provisioning.js";

export {
  WorkspaceHost,
  parseProjectBudget,
  resetWorkspaceStorage,
  type WorkspaceResetResult,
  WORKSPACE_CONTAINER_RESET_SPEC,
} from "./host.js";

export * from "./project/index.js";

export {
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  type ParsedProjectRemovalRequest,
  type ProjectRemovalRequest,
  type ProjectRemovalWorkspaceHost,
} from "./project-removal.js";
