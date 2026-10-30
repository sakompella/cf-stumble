export { ConnectedProjects } from "./connected-projects.js";

// The connection surface is written in terms of the workspace views it uses, so the group states
// them here rather than making every consumer reach for `workspace` to name one argument.
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

export { startFacetTurn } from "./project-turn.js";

export {
  runProjectTurn,
  type FacetTurnHandoff,
  type ProjectTurnRun,
  type ProjectTurnRunProblemCode,
  type RunProjectTurnInput,
  type TurnStartContext,
} from "./turn-run.js";

export { TURN_PROGRESS_FRAME_MAX_BYTES, TURN_TERMINAL_FRAME_MAX_BYTES } from "./turn-frames.js";

export type { ProjectTurnFacet, ProjectTurnStart, TurnWorkspace } from "./project-turn.js";

export type { ProjectCapabilityStub, ProjectWorkspaceNamespace } from "./project-workspace.js";
