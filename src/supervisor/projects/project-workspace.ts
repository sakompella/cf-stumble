import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

type ProjectWorkspaceHost = Readonly<{
  project(budget: Readonly<{ remainingMs: number }>): Promise<ProjectCapabilityStub>;
}>;

export type ProjectCapabilityStub = ProjectRpcTargetContract &
  Disposable &
  Readonly<{ dup(): ProjectRpcTargetContract & Disposable }>;

export type ProjectWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectWorkspaceHost;
}>;
