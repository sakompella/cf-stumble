import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * This view has no `build` and no `execute`, so the project path cannot run a harness build step
 * even though one Durable Object class serves both surfaces.
 */
type ProjectWorkspaceHost = Readonly<{
  project(budget: Readonly<{ remainingMs: number }>): Promise<ProjectCapabilityStub>;
}>;

/** A holder must duplicate the stub to keep it past the call that received it. */
export type ProjectCapabilityStub = ProjectRpcTargetContract &
  Disposable &
  Readonly<{ dup(): ProjectRpcTargetContract & Disposable }>;

/**
 * The Supervisor names the workspace from its server-derived tenant key, so no request can name a
 * workspace or reach another tenant's files.
 */
export type ProjectWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectWorkspaceHost;
}>;
