import { Result } from "better-result";
import { redactCredentials } from "../github/index.js";
import {
  PROJECT_PROVISION_STEP_NAMES,
  type ProjectProvisionStepName,
} from "../project-provision.js";
import {
  resolveProject,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../project-catalog.js";
import type { WorkspaceResult } from "./decisions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";

/** The Workspace Host provision surface as its caller uses it: a project and a planned step. */
export type ProvisionWorkspaceHost = Readonly<{
  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult>;
}>;

/**
 * Just enough of the Workspace Host binding to reach the tenant's workspace by name. The caller
 * holds that name, which the Supervisor derives from its own tenant key, so no request can name a
 * workspace.
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

export interface ProvisionProjectWorkspaceInput {
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  /** The client-supplied project id. The catalog resolves it before anything is provisioned. */
  readonly projectId: unknown;
  readonly catalog?: ProjectCatalog;
  readonly namespace: ProvisionWorkspaceNamespace;
  /** Stops the plan before another workspace RPC when the owning turn has ended. */
  readonly signal?: AbortSignal;
}

/**
 * What each step's result must look like. A step that answers with the other shape means the host
 * surface changed under this caller, which is worth reporting rather than reading past.
 */
const STEP_RESULT_KIND = {
  clone: "command",
  instructions: "written",
} as const satisfies Record<ProjectProvisionStepName, "command" | "written">;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The Workspace Host RPC may reject with any thrown value.
function redactedCause(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return redactCredentials(detail).slice(0, 400);
}

async function runStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectProvisionStepName,
  signal: AbortSignal | undefined,
): Promise<Result<ProjectProvisionStepName, ProjectProvisionProblem>> {
  const projectId = project.id;

  const unavailable: Result<ProjectProvisionStepName, ProjectProvisionProblem> = Result.err({
    code: "provision-workspace-unavailable",
    projectId,
    step,
  });

  if (signal !== undefined && signal.aborted) {
    return unavailable;
  }

  let result: WorkspaceResult;

  try {
    result = await host.provision({
      kind: "provision-project",
      projectId,
      repositoryUrl: project.repositoryUrl,
      step,
    });
  } catch (error) {
    console.error("project provision RPC failed", {
      projectId,
      step,
      cause: redactedCause(error),
    });

    return unavailable;
  }

  if (signal !== undefined && signal.aborted) {
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

type ProvisioningOutcome = Result<ProvisionedProjectWorkspace, ProjectProvisionProblem>;

/** Active plans keyed by tenant workspace and project, so a timed-out turn cannot overlap a retry. */
const activeProvisions = new Map<string, Promise<ProvisioningOutcome>>();

function provisioningKey(workspaceName: string, project: Project): string {
  return `${workspaceName}:${project.id}`;
}

function abortedProvision(project: Project): ProvisioningOutcome {
  return Result.err({
    code: "provision-workspace-unavailable",
    projectId: project.id,
    step: "clone",
  });
}

/**
 * Provision one project inside the tenant's workspace: reconcile its clone, then rewrite the
 * managed instructions.
 *
 * Every run performs every step. Nothing here remembers that a workspace was provisioned before,
 * because the state that matters lives in the workspace and not in the caller: the Workspace Host
 * can be evicted, and a Supervisor that skipped the clone on the strength of its own memory would
 * be deciding from the wrong place. Each step is written to converge, so a run after an
 * interrupted one asks for exactly what the interrupted one asked for.
 *
 * The project id is resolved against the catalog first, so only a project the server recognizes is
 * provisioned, and the repository URL is never a value this function carries. The workspace name
 * belongs to the tenant, not to the project: the id selects a directory inside that one workspace.
 */
export function provisionProjectWorkspace(
  input: ProvisionProjectWorkspaceInput,
): Promise<ProvisioningOutcome> {
  const resolved = resolveProject(input.projectId, input.catalog);

  if (!resolved.ok) {
    return Promise.resolve(Result.err({ code: "project-not-in-catalog", reason: resolved.reason }));
  }

  const project = resolved.project;
  const key = provisioningKey(input.workspaceName, project);
  const previous = activeProvisions.get(key);
  const operation = provisionAfter(previous, input, project);
  activeProvisions.set(key, operation);

  return operation.finally(() => {
    if (activeProvisions.get(key) === operation) {
      activeProvisions.delete(key);
    }
  });
}

async function provisionAfter(
  previous: Promise<ProvisioningOutcome> | undefined,
  input: ProvisionProjectWorkspaceInput,
  project: Project,
): Promise<ProvisioningOutcome> {
  if (previous !== undefined) {
    try {
      await previous;
    } catch {
      // A replacement retries after an unexpected failure, once the old plan has settled.
    }
  }

  if (input.signal !== undefined && input.signal.aborted) {
    return abortedProvision(project);
  }

  return provisionResolvedProject(input, project);
}

async function provisionResolvedProject(
  input: ProvisionProjectWorkspaceInput,
  project: Project,
): Promise<Result<ProvisionedProjectWorkspace, ProjectProvisionProblem>> {
  const host = input.namespace.getByName(input.workspaceName);

  for (const step of PROJECT_PROVISION_STEP_NAMES) {
    const ran = await runStep(host, project, step, input.signal);

    if (ran.isErr()) {
      return Result.err(ran.error);
    }
  }

  return Result.ok({ projectId: project.id, workspaceName: input.workspaceName });
}
