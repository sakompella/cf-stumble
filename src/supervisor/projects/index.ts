export type {
  CredentialWorkspaceNamespace,
  ProvisionWorkspaceNamespace,
  ProjectRemovalWorkspaceNamespace,
} from "../../workspace/index.js";

export { GitHubConnection, type GitHubConnectionEnvironment } from "./github-connection.js";

export type {
  GitHubAuthorizationOutcome,
  GitHubAuthorizationProblem,
  GitHubConnectionRecord,
} from "./github-connection-status.js";

export { GitHubConnectionStore } from "./github-connection-store.js";

export {
  ProjectConnections,
  type ConnectRepositoryResult,
  type DisconnectRepositoryResult,
} from "./project-connections.js";

export type { ProjectCapabilityStub, ProjectWorkspaceNamespace } from "./project-workspace.js";
