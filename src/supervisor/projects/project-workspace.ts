import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * The Workspace Host project surface as the Supervisor uses it: one call that hands out one
 * project's capability. This view has no `build` and no `execute`, so the project path cannot run
 * a harness build step and the build path cannot read a project file, even though one Durable
 * Object class serves both surfaces.
 */
export type ProjectWorkspaceHost = Readonly<{
  project(): Promise<ProjectRpcTargetContract>;
}>;

/**
 * Just enough of the Workspace Host binding to reach one project workspace by name. The Supervisor
 * derives that name itself from a catalog-resolved project, so no request can name a workspace and
 * no request can reach another project's or another tenant's files.
 */
export type ProjectWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectWorkspaceHost;
}>;
