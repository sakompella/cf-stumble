export { ConnectedProjects } from "./connected-projects.js";

// The connection surface is written in terms of the tenant the boundary verified and of the two
// workspace views it uses, so the group states them here rather than making every consumer reach
// for `access` and `workspace` to name one argument.
export type { VerifiedAccessScope } from "../../access/index.js";

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
  type GitHubConnectionStatus,
} from "./github-connection.js";

export { GitHubConnectionStore } from "./github-connection-store.js";

export {
  ProjectConnections,
  type ConnectRepositoryResult,
  type DisconnectRepositoryResult,
  type ProjectListView,
} from "./project-connections.js";

export { startFacetTurn } from "./project-turn.js";

export {
  runProjectTurn,
  type FacetTurnHandoff,
  type ProjectTurnRun,
  type ProjectTurnRunProblemCode,
  type RunProjectTurnInput,
  type TurnStartContext,
} from "./turn-run.js";

export { PROJECT_TURN_FRAME_MAX_BYTES } from "./turn-frames.js";

export { timedTurnMount, timedTurnProvision } from "./turn-log.js";

export type { ProjectTurnFacet, ProjectTurnStart, TurnWorkspace } from "./project-turn.js";

export type { ProjectCapabilityStub, ProjectWorkspaceNamespace } from "./project-workspace.js";
