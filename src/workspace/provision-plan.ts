import type * as Effect from "effect/Effect";
import type { ProjectProvisionStepName } from "../project-provision.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../workspace-command-timeout.js";
import type { HarnessBuildRequest } from "../harness-build.js";
import type { WorkspaceResult } from "./decisions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";
import type { ProjectRemovalWorkspaceHost } from "./project-removal.js";
import { workspaceRpc, type WorkspaceRpcFailed } from "./workspace-rpc.js";

export type ProjectPlanStepName = ProjectProvisionStepName | "instructions";

export const PROJECT_PLAN_STEP_NAMES: readonly ProjectPlanStepName[] = ["clone", "instructions"];

export type HarnessProvisionStepName = "provision" | "instructions";

export const HARNESS_PROVISION_STEP_NAMES: readonly HarnessProvisionStepName[] = [
  "provision",
  "instructions",
];

export type ManagedInstructionsWorkspaceHost = Readonly<{
  ensureManagedInstructions(): Promise<WorkspaceResult>;
}>;

export type ProvisionWorkspaceHost = ManagedInstructionsWorkspaceHost &
  Readonly<{
    provision(request: ProjectProvisionRequest): Promise<WorkspaceResult>;
  }>;

export type HarnessProvisionWorkspaceHost = ManagedInstructionsWorkspaceHost &
  Readonly<{
    build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
  }>;

export type ProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): ProvisionWorkspaceHost;
}>;

export type ProjectRemovalWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectRemovalWorkspaceHost;
}>;

export type HarnessProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): HarnessProvisionWorkspaceHost;
}>;

export type ProvisionRpc = Effect.Effect<WorkspaceResult, WorkspaceRpcFailed>;

export function provisionRpc(call: () => Promise<WorkspaceResult>): ProvisionRpc {
  return workspaceRpc(call, WORKSPACE_RPC_TIMEOUT_MS);
}

export function writeManagedInstructions(host: ManagedInstructionsWorkspaceHost): ProvisionRpc {
  return provisionRpc(() => host.ensureManagedInstructions());
}
