import { Result } from "better-result";
import {
  PROJECT_PROVISION_STEP_NAMES,
  type ProjectProvisionStepName,
} from "../project-provision.js";
import {
  resolveProjectWorkspaceName,
  type ResolveProjectWorkspaceNameInput,
} from "../workspace-names.js";
import type { ProjectId } from "../project-catalog.js";
import type { WorkspaceResult } from "./decisions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";

/** The Workspace Host provision surface as its caller uses it: a project and a planned step. */
export type ProvisionWorkspaceHost = Readonly<{
  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult>;
}>;

/**
 * Just enough of the Workspace Host binding to reach one project workspace by name. The caller
 * derives that name from a catalog-resolved project, so no request can name a workspace.
 */
export type ProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): ProvisionWorkspaceHost;
}>;

/**
 * Why provisioning stopped. These stay plain values: a caller that has to report the outcome over
 * RPC can return one unchanged (ADR-0035).
 */
export type ProjectProvisionProblem =
  | Readonly<{
      code: "project-not-in-catalog";
      reason: "invalid-project-id" | "unknown-project-id";
    }>
  | Readonly<{
      code: "provision-step-failed";
      projectId: ProjectId;
      step: ProjectProvisionStepName;
      exitCode: number;
    }>
  | Readonly<{
      code: "provision-workspace-unavailable";
      projectId: ProjectId;
      step: ProjectProvisionStepName;
    }>;

export type ProvisionedProjectWorkspace = Readonly<{
  projectId: ProjectId;
  workspaceName: string;
}>;

export interface ProvisionProjectWorkspaceInput extends ResolveProjectWorkspaceNameInput {
  readonly namespace: ProvisionWorkspaceNamespace;
}

/**
 * What each step's result must look like. A step that answers with the other shape means the host
 * surface changed under this caller, which is worth reporting rather than reading past.
 */
const STEP_RESULT_KIND = {
  clone: "command",
  instructions: "written",
} as const satisfies Record<ProjectProvisionStepName, "command" | "written">;

async function runStep(
  host: ProvisionWorkspaceHost,
  projectId: ProjectId,
  step: ProjectProvisionStepName,
): Promise<Result<ProjectProvisionStepName, ProjectProvisionProblem>> {
  const unavailable: Result<ProjectProvisionStepName, ProjectProvisionProblem> = Result.err({
    code: "provision-workspace-unavailable",
    projectId,
    step,
  });

  let result: WorkspaceResult;
  try {
    result = await host.provision({ kind: "provision-project", projectId, step });
  } catch {
    return unavailable;
  }

  if (!result.ok || result.result.kind !== STEP_RESULT_KIND[step]) {
    return unavailable;
  }
  if (result.result.kind === "command" && result.result.exitCode !== 0) {
    return Result.err({
      code: "provision-step-failed",
      projectId,
      step,
      exitCode: result.result.exitCode,
    });
  }

  return Result.ok(step);
}

/**
 * Provision one project's workspace: reconcile its clone, then rewrite the managed instructions.
 *
 * Every run performs every step. Nothing here remembers that a workspace was provisioned before,
 * because the state that matters lives in the workspace and not in the caller: the Workspace Host
 * can be evicted, and a Supervisor that skipped the clone on the strength of its own memory would
 * be deciding from the wrong place. Each step is written to converge, so a run after an
 * interrupted one asks for exactly what the interrupted one asked for.
 *
 * The project id is resolved against the catalog first, so a workspace name exists only for a
 * project the server recognizes, and the repository URL is never a value this function carries.
 */
export async function provisionProjectWorkspace(
  input: ProvisionProjectWorkspaceInput,
): Promise<Result<ProvisionedProjectWorkspace, ProjectProvisionProblem>> {
  const resolved = await resolveProjectWorkspaceName(input);
  if (!resolved.ok) {
    return Result.err({ code: "project-not-in-catalog", reason: resolved.reason });
  }

  const host = input.namespace.getByName(resolved.workspaceName);
  const projectId = resolved.project.id;
  for (const step of PROJECT_PROVISION_STEP_NAMES) {
    const ran = await runStep(host, projectId, step);
    if (ran.isErr()) {
      return Result.err(ran.error);
    }
  }

  return Result.ok({ projectId, workspaceName: resolved.workspaceName });
}
