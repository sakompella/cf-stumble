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
