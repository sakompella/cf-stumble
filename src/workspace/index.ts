export { ComputerWorkspaceOperations } from "./computer-operations.js";

export { type WorkspaceFailure, type WorkspacePlan, type WorkspaceResult } from "./decisions.js";

export {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
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
  provisionProjectWorkspace,
  type ProjectProvisionProblem,
  type ProvisionedProjectWorkspace,
  type ProvisionProjectWorkspaceInput,
  type ProvisionWorkspaceHost,
  type ProvisionWorkspaceNamespace,
} from "./provisioning.js";

export { WorkspaceHost } from "./host.js";

export * from "./project/index.js";
