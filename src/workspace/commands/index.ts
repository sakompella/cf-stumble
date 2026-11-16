export type { HarnessBuildStepRequest } from "../../harness-build.js";

export {
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
  harnessBuildConfiguration,
} from "./build-harness.js";

export {
  readHarnessLineage,
  UNKNOWN_LINEAGE,
  type HarnessLineage,
  type HarnessLineageRequest,
} from "./harness-lineage.js";

export {
  executeProjectProvisionRequest,
  type CloneSizeVerdict,
  type ProjectProvisionAnswer,
  type ProjectProvisionRequest,
} from "./provision-project.js";

export { executeProjectRemovalRequest, type ProjectRemovalRequest } from "./remove-project.js";

export {
  type CommandAnswer,
  type InstructionsWriteResult,
  type ModuleMapAnswer,
} from "./command-result.js";

export {
  checkGitHubRepositoryAccess,
  installGitHubCredential,
  readGitHubCredentialStatus,
  type CredentialInstallResult,
  type CredentialStatusResult,
  type RepositoryAccessResult,
} from "../github-credential.js";

export { ensureManagedInstructions } from "../managed-instructions.js";

export { ComputerWorkspaceOperations } from "../computer-operations.js";
