import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * The Workspace Host project surface as the Supervisor uses it: one call that hands out the
 * workspace capability a turn works through. This view has no `build` and no `execute`, so the
 * project path cannot run a harness build step, even though one Durable Object class serves both
 * surfaces.
 */
type ProjectWorkspaceHost = Readonly<{
  project(): Promise<ProjectCapabilityStub>;
}>;

/**
 * The project capability as Workers RPC hands it over: a stub, which a holder duplicates to keep it
 * past the call that received it.
 */
export type ProjectCapabilityStub = ProjectRpcTargetContract &
  Readonly<{ dup(): ProjectRpcTargetContract & Disposable }>;

/**
 * Just enough of the Workspace Host binding to reach the tenant's workspace by name. The Supervisor
 * names it from its own server-derived tenant key, so no request can name a workspace and no
 * request can reach another tenant's files. Within the workspace, repositories are directories and
 * not boundaries (ADR-0038).
 */
export type ProjectWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectWorkspaceHost;
}>;
