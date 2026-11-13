import type { WorkspaceHost } from "./host.js";
import type { ProjectRpcTargetContract } from "./project/protocol.js";

export type ProjectCapabilityStub = ProjectRpcTargetContract &
  Disposable &
  Readonly<{ dup(): ProjectRpcTargetContract & Disposable }>;

type HostRpc = Readonly<
  Pick<
    WorkspaceHost,
    | "build"
    | "lineage"
    | "provision"
    | "removeProject"
    | "ensureManagedInstructions"
    | "credential"
    | "backend"
    | "setBackend"
    | "reset"
  > & {
    project(budget: Parameters<WorkspaceHost["project"]>[0]): Promise<ProjectCapabilityStub>;
  }
>;

export type WorkspaceHostRpc<Method extends keyof HostRpc = keyof HostRpc> = Pick<HostRpc, Method>;

export type WorkspaceHostNamespace<Method extends keyof HostRpc = keyof HostRpc> = Readonly<{
  getByName(name: string): WorkspaceHostRpc<Method>;
}>;
