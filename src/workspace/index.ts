export {
  UNKNOWN_LINEAGE,
  type CloneSizeVerdict,
  type CommandAnswer,
  type HarnessLineage,
  type ProjectProvisionAnswer,
} from "./commands/index.js";

export { type CommandOutput } from "./operations.js";

export {
  checkRepositoryAccess,
  type CredentialNamespace,
  type CredentialWorkspaceUnavailable,
  installWorkspaceCredential,
  readWorkspaceCredentialStatus,
} from "./credential-access.js";

export { WorkspaceHost } from "./host.js";

export type {
  ProjectCapabilityStub,
  WorkspaceHostNamespace,
  WorkspaceHostRpc,
} from "./host-rpc.js";

export { IsolateEgressGateway } from "./project/index.js";

export { WORKSPACE_BUSY, type WorkspaceResetResult } from "./workspace-reset.js";
