export { ConnectedProjects } from "./connected-projects.js";

export type {
  CredentialWorkspaceNamespace,
  ProvisionWorkspaceNamespace,
  ProjectRemovalWorkspaceNamespace,
} from "../../workspace/index.js";

export {
  GitHubConnection,
  type GitHubAuthorizationOutcome,
  type GitHubAuthorizationProblem,
  type GitHubConnectionEnvironment,
  type GitHubConnectionRecord,
  type GitHubConnectionStatus,
} from "./github-connection.js";

export { GitHubConnectionStore } from "./github-connection-store.js";

export {
  ProjectConnections,
  type ConnectRepositoryResult,
  type DisconnectRepositoryResult,
} from "./project-connections.js";

export type { ProjectCapabilityStub, ProjectWorkspaceNamespace } from "./project-workspace.js";
