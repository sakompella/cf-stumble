import { Result } from "better-result";
import { logRedactedCause } from "../diagnostics.js";
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
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";

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
  readonly signal?: AbortSignal | undefined;
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
    logRedactedCause(
      `project-provision.${step}: provision-workspace-unavailable (${projectId})`,
      error,
    );

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

type ActiveProvision = Readonly<{
  operation: Promise<ProvisioningOutcome>;
  startedAt: number;
}>;

/** The host kills a command at its ceiling; this margin covers the RPC's final settling turn. */
export const PROVISION_STALE_MARGIN_MS = 1_000;

const PROVISION_COMMAND_BUDGET_MS = PROJECT_PROVISION_STEP_NAMES.reduce(
  (budget, step) =>
    budget + (STEP_RESULT_KIND[step] === "command" ? WORKSPACE_COMMAND_TIMEOUT_MS : 0),
  0,
);

export const PROVISION_STALE_AFTER_MS = PROVISION_COMMAND_BUDGET_MS + PROVISION_STALE_MARGIN_MS;

/**
 * Active plans are keyed by the whole tenant workspace, not a project directory. A project turn
 * can reach sibling repositories and the managed instructions, and a harness turn has the same
 * capability, so neither may enter while another project's orphaned provision can still write.
 *
 * This is an isolate-local exclusion. The Workspace Host remains the real filesystem owner; after
 * this Supervisor is evicted, only a Workspace Host-side protocol can prove that an old RPC stopped.
 */
const activeProvisions = new Map<string, ActiveProvision>();

function provisionIsStale(active: ActiveProvision, now: number): boolean {
  return now - active.startedAt > PROVISION_STALE_AFTER_MS;
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

  return provisionInWorkspace(input, resolved.project);
}

/** Wait for the current workspace provision, without joining it or starting a replacement. */
export async function waitForWorkspaceProvision(
  workspaceName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    const active = activeProvisions.get(workspaceName);

    if (active === undefined) return signal?.aborted !== true;

    if (provisionIsStale(active, Date.now())) {
      activeProvisions.delete(workspaceName);

      continue;
    }

    const wait = await waitForActiveProvision(active, signal);

    if (wait === "aborted") return false;

    if (wait === "settled") return true;
  }
}

async function provisionInWorkspace(
  input: ProvisionProjectWorkspaceInput,
  project: Project,
): Promise<ProvisioningOutcome> {
  for (;;) {
    const active = activeProvisions.get(input.workspaceName);

    if (active !== undefined && !provisionIsStale(active, Date.now())) {
      const wait = await waitForActiveProvision(active, input.signal);

      if (wait === "aborted") return abortedProvision(project);

      // The old operation has settled or gone stale. Reconcile this caller's project now.
      continue;
    }

    if (active !== undefined) {
      activeProvisions.delete(input.workspaceName);
    }

    if (input.signal?.aborted === true) return abortedProvision(project);

    const operation = provisionResolvedProject(input, project);
    const tracked: ActiveProvision = { operation, startedAt: Date.now() };
    activeProvisions.set(input.workspaceName, tracked);

    operation.then(
      () => {
        removeActiveProvision(input.workspaceName, tracked);
      },
      () => {
        removeActiveProvision(input.workspaceName, tracked);
      },
    );

    return operation;
  }
}

function removeActiveProvision(workspaceName: string, active: ActiveProvision): void {
  if (activeProvisions.get(workspaceName) === active) {
    activeProvisions.delete(workspaceName);
  }
}

type ProvisionWait = "settled" | "aborted" | "stale";

function waitForActiveProvision(
  active: ActiveProvision,
  signal: AbortSignal | undefined,
): Promise<ProvisionWait> {
  if (signal?.aborted === true) return Promise.resolve("aborted");

  const remaining = Math.max(0, PROVISION_STALE_AFTER_MS - (Date.now() - active.startedAt) + 1);

  return new Promise((resolve) => {
    let finished = false;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ProvisionWait) => {
      if (finished) return;
      finished = true;

      if (staleTimer !== undefined) clearTimeout(staleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      finish("aborted");
    };

    staleTimer = setTimeout(() => {
      finish("stale");
    }, remaining);
    signal?.addEventListener("abort", onAbort, { once: true });

    active.operation.then(
      () => {
        finish("settled");
      },
      () => {
        finish("settled");
      },
    );
  });
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
