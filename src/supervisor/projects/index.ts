export { ConnectedProjects, type ConnectedProject } from "./connected-projects.js";
// The connection surface is written in terms of the tenant the boundary verified and of the two
// workspace views it uses, so the group states them here rather than making every consumer reach
// for `access` and `workspace` to name one argument.
export type { VerifiedAccessScope } from "../../access/index.js";
export type {
  CredentialWorkspaceNamespace,
  ProvisionWorkspaceNamespace,
} from "../../workspace/index.js";
export {
  GitHubConnection,
  type GitHubAuthorizationOutcome,
  type GitHubAuthorizationProblem,
  type GitHubConnectionEnvironment,
  type GitHubConnectionStatus,
} from "./github-connection.js";
export {
  GitHubConnectionStore,
  type CredentialSource,
  type PendingAuthorization,
  type RecordedConnection,
} from "./github-connection-store.js";
export {
  ProjectConnections,
  type ConnectRepositoryProblem,
  type ConnectRepositoryResult,
  type ProjectListView,
  type ProjectUseProblem,
  type ProjectUseResult,
} from "./project-connections.js";
export { streamProjectTurn } from "./project-turn.js";
// The Supervisor names its own workspace and hands that name to both the project path here and the
// build path in `artifacts`. It reaches the one definition through this group rather than deriving
// a second one, which is the drift E3 recorded.
export { tenantWorkspaceName } from "../../workspace-names.js";
export type {
  MountServingGeneration,
  ProjectTurnFacet,
  ProjectTurnInput,
  ProjectTurnRefusal,
  ProjectTurnRequest,
  ProjectTurnStart,
} from "./project-turn.js";
export type { ProjectWorkspaceHost, ProjectWorkspaceNamespace } from "./project-workspace.js";
