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
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
  ProvisionStepFailed,
  ProvisionWorkspaceUnavailable,
} from "./provisioning.js";

export {
  waitForWorkspaceProvision,
  clearWorkspaceProvision,
  PROVISION_STALE_AFTER_MS,
} from "./provision-exclusion.js";

export type {
  HarnessProvisionWorkspaceNamespace,
  ProvisionWorkspaceHost,
  ProvisionWorkspaceNamespace,
  ProjectRemovalWorkspaceNamespace,
} from "./provision-plan.js";

export { WorkspaceHost } from "./host.js";

export { type WorkspaceResetResult } from "./workspace-reset.js";

export {
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  type ProjectRemovalRequest,
} from "./project-removal.js";
