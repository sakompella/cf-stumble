import type { Workspace } from "@cloudflare/computer";
import type * as Effect from "effect/Effect";
import { harnessBuildConfiguration, type HarnessBuildRequest } from "../harness-build.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import type { WorkspaceResult } from "./decisions.js";
import {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
} from "./executor.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
} from "./github-credential.js";
import { ensureManagedInstructions } from "./managed-instructions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";
import type { ProjectRemovalRequest } from "./project-removal.js";

export type {
  GitHubCredentialRequest,
  GitHubCredentialResult,
  HarnessBuildRequest,
  ProjectProvisionRequest,
  ProjectRemovalRequest,
  WorkspaceResult,
};

export function workspaceSurfaces(workspace: Workspace, harnessRepositoryUrl: string | undefined) {
  const lenient = () => new ComputerWorkspaceOperations(workspace, "not-required");
  const durable = () => new ComputerWorkspaceOperations(workspace, "require-complete");

  return {
    build: (request: HarnessBuildRequest): Effect.Effect<WorkspaceResult> =>
      executeHarnessBuildRequest({
        configuration: harnessBuildConfiguration(harnessRepositoryUrl),
        operations: lenient(),
        request,
      }),
    provision: (request: ProjectProvisionRequest): Effect.Effect<WorkspaceResult> =>
      executeProjectProvisionRequest({ operations: durable(), request }),
    removeProject: (request: ProjectRemovalRequest): Effect.Effect<WorkspaceResult> =>
      executeProjectRemovalRequest({ operations: durable(), request }),
    credential: (request: GitHubCredentialRequest): Effect.Effect<GitHubCredentialResult> =>
      executeGitHubCredentialRequest({
        operations: lenient(),
        installOperations: durable(),
        request,
      }),
    ensureManagedInstructions: (): Effect.Effect<WorkspaceResult> =>
      ensureManagedInstructions(lenient()),
  };
}
