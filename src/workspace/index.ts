export { type WorkspacePlan, type WorkspaceResult } from "./decisions.js";

export {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "./executor.js";

export { parseHarnessBuildRequest, planHarnessBuildRequest } from "./harness-build.js";

export {
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "./project-provision.js";

export {
  checkRepositoryAccess,
  CredentialInstallFailed,
  CredentialWorkspaceUnavailable,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
  type CredentialWorkspaceHost,
  type CredentialWorkspaceNamespace,
  type WorkspaceCredentialInput,
} from "./credential-access.js";

export {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
} from "./github-credential.js";

export {
  HarnessProvisionStepFailed,
  HarnessProvisionWorkspaceUnavailable,
  ProjectNotInCatalog,
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
  ProvisionStepFailed,
  ProvisionWorkspaceUnavailable,
  waitForWorkspaceProvision,
  clearWorkspaceProvision,
  PROVISION_STALE_AFTER_MS,
  type HarnessProvisionWorkspaceNamespace,
  type ProvisionWorkspaceHost,
  type ProvisionWorkspaceNamespace,
  type ProjectRemovalWorkspaceNamespace,
} from "./provisioning.js";

export { WorkspaceHost, type WorkspaceResetResult } from "./host.js";

export {
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  type ProjectRemovalRequest,
} from "./project-removal.js";
