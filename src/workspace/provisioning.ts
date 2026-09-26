// oxlint-disable max-lines -- Project and harness provisioning share one workspace exclusion.
import { Result } from "better-result";
import {
  logEvent,
  logRedactedCause,
  timed,
  timedWorkspaceRpc,
  WORKSPACE_RPC_TIMEOUT_MARGIN_MS,
  type TimedOutcome,
} from "../diagnostics.js";
import {
  PROJECT_CLONE_SIZE_MARKER,
  PROJECT_PROVISION_STEP_NAMES,
  type ProjectProvisionStepName,
} from "../project-provision.js";
import {
  resolveProject,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../project-catalog.js";
import type { HarnessCommit } from "../harness-commit.js";
import type { HarnessBuildRequest } from "../harness-build.js";
import type { WorkspaceResult } from "./decisions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";

/** The Workspace Host provision surface as its caller uses it: a project and a planned step. */
export type ProvisionWorkspaceHost = Readonly<{
  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult>;
}>;

/** The harness's two operations use the build-side clone reconciler and the managed file writer. */
export type HarnessProvisionWorkspaceHost = Readonly<{
  build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
  ensureManagedInstructions(): Promise<WorkspaceResult>;
}>;

/**
 * Just enough of the Workspace Host binding to reach the tenant's workspace by name. The caller
 * holds that name, which the Supervisor derives from its own tenant key, so no request can name a
 * workspace.
 */
export type ProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): ProvisionWorkspaceHost;
}>;

export type HarnessProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): HarnessProvisionWorkspaceHost;
}>;

/**
 * Why project provisioning stopped. These stay plain values: a caller that has to report the
 * outcome over RPC can return one unchanged (ADR-0035).
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

export type HarnessProvisionStepName = "provision" | "instructions";

const HARNESS_PROVISION_STEP_NAMES: readonly HarnessProvisionStepName[] = [
  "provision",
  "instructions",
];

export type HarnessProvisionProblem =
  | Readonly<{
      code: "harness-provision-step-failed";
      step: HarnessProvisionStepName;
      exitCode: number;
    }>
  | Readonly<{
      code: "harness-provision-workspace-unavailable";
      step: HarnessProvisionStepName;
    }>;

export type ProvisionedHarnessWorkspace = Readonly<{ workspaceName: string }>;

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

export interface ProvisionHarnessWorkspaceInput {
  readonly workspaceName: string;
  /** The active generation's validated commit, which the build provisioner obtains if needed. */
  readonly harnessCommit: HarnessCommit;
  readonly namespace: HarnessProvisionWorkspaceNamespace;
  readonly signal?: AbortSignal | undefined;
}

const STEP_RESULT_KIND = {
  clone: "command",
  instructions: "written",
} as const satisfies Record<ProjectProvisionStepName, "command" | "written">;

function runProjectHostStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectProvisionStepName,
): Promise<WorkspaceResult> {
  return timedWorkspaceRpc(
    { method: "provision", step },
    () =>
      host.provision({
        kind: "provision-project",
        projectId: project.id,
        repositoryUrl: project.repositoryUrl,
        step,
      }),
    (answered) =>
      answered.ok ? { outcome: "ok" } : { outcome: answered.error.code, level: "warn" },
    PROVISION_RPC_TIMEOUT_MS,
  );
}

function cloneSizeKb(result: WorkspaceResult): number | null {
  if (!result.ok || result.result.kind !== "command") return null;

  const marker = result.result.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(PROJECT_CLONE_SIZE_MARKER));

  if (marker === undefined) return null;

  const size = Number(marker.slice(PROJECT_CLONE_SIZE_MARKER.length));

  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

type CloneOutcome = "ok" | "failed" | "unavailable";

function logClone(
  projectId: ProjectId,
  startedAt: number,
  result: WorkspaceResult | undefined,
  outcome: CloneOutcome,
): void {
  logEvent(outcome === "ok" ? "info" : "warn", "workspace.clone", {
    project: projectId,
    durationMs: Date.now() - startedAt,
    sizeKb: result === undefined ? null : cloneSizeKb(result),
    outcome,
  });
}

// oxlint-disable-next-line max-lines-per-function -- The step validates the shared RPC result before advancing the plan.
async function runProjectStep(
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

  if (signal !== undefined && signal.aborted) return unavailable;

  let result: WorkspaceResult;
  const startedAt = Date.now();

  try {
    result = await runProjectHostStep(host, project, step);
  } catch (error) {
    if (step === "clone") logClone(projectId, startedAt, undefined, "unavailable");
    logRedactedCause(
      `project-provision.${step}: provision-workspace-unavailable (${projectId})`,
      error,
    );

    return unavailable;
  }

  if (step === "clone") {
    const outcome: CloneOutcome =
      !result.ok || result.result.kind !== "command"
        ? "unavailable"
        : result.result.exitCode === 0
          ? "ok"
          : "failed";

    logClone(projectId, startedAt, result, outcome);
  }

  if (
    (signal !== undefined && signal.aborted) ||
    !result.ok ||
    result.result.kind !== STEP_RESULT_KIND[step]
  ) {
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

async function runHarnessStep(
  host: HarnessProvisionWorkspaceHost,
  harnessCommit: HarnessCommit,
  step: HarnessProvisionStepName,
  signal: AbortSignal | undefined,
): Promise<Result<HarnessProvisionStepName, HarnessProvisionProblem>> {
  const unavailable: Result<HarnessProvisionStepName, HarnessProvisionProblem> = Result.err({
    code: "harness-provision-workspace-unavailable",
    step,
  });

  if (signal !== undefined && signal.aborted) return unavailable;

  let result: WorkspaceResult;

  try {
    result =
      step === "provision"
        ? await timedWorkspaceRpc(
            { method: "build", step },
            () => host.build({ kind: "build-step", harnessCommit, step }),
            (answered) =>
              answered.ok ? { outcome: "ok" } : { outcome: answered.error.code, level: "warn" },
            PROVISION_RPC_TIMEOUT_MS,
          )
        : await timedWorkspaceRpc(
            { method: "ensureManagedInstructions", step },
            () => host.ensureManagedInstructions(),
            (answered) =>
              answered.ok ? { outcome: "ok" } : { outcome: answered.error.code, level: "warn" },
            PROVISION_RPC_TIMEOUT_MS,
          );
  } catch (error) {
    logRedactedCause(`harness-provision.${step}: workspace-unavailable`, error);

    return unavailable;
  }

  if ((signal !== undefined && signal.aborted) || !result.ok) return unavailable;

  if (step === "provision") {
    if (result.result.kind !== "command") return unavailable;

    if (result.result.exitCode !== 0) {
      return Result.err({
        code: "harness-provision-step-failed",
        step,
        exitCode: result.result.exitCode,
      });
    }
  } else if (result.result.kind !== "written") {
    return unavailable;
  }

  return Result.ok(step);
}

/** A step's log outcome: `ok`, or the problem code and, for a command, its exit code. */
function stepOutcome<Step>(
  ran: Result<Step, ProjectProvisionProblem | HarnessProvisionProblem>,
): TimedOutcome {
  if (ran.isOk()) return { outcome: "ok" };

  const problem = ran.error;

  return {
    outcome: problem.code,
    level: "warn",
    fields: "exitCode" in problem ? { exitCode: problem.exitCode } : {},
  };
}

type ProvisioningOutcome = Result<ProvisionedProjectWorkspace, ProjectProvisionProblem>;

type HarnessProvisioningOutcome = Result<ProvisionedHarnessWorkspace, HarnessProvisionProblem>;

type ActiveProvision = Readonly<{
  operation: Promise<unknown>;
  startedAt: number;
}>;

/** The host kills a command at its ceiling; this margin covers the RPC's final settling turn. */
export const PROVISION_STALE_MARGIN_MS = WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

/** Each Workspace Host call has the command ceiling plus its RPC settling margin. */
export const PROVISION_RPC_TIMEOUT_MS =
  WORKSPACE_COMMAND_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

const PROVISION_PLAN_STEP_COUNT = Math.max(
  PROJECT_PROVISION_STEP_NAMES.length,
  HARNESS_PROVISION_STEP_NAMES.length,
);

export const PROVISION_STALE_AFTER_MS =
  PROVISION_PLAN_STEP_COUNT * PROVISION_RPC_TIMEOUT_MS + PROVISION_STALE_MARGIN_MS;

/**
 * Active plans are keyed by the whole tenant workspace, not a project directory. A project turn
 * can reach sibling repositories and the managed instructions, and a harness turn has the same
 * capability, so neither may enter while another project's orphaned provision can still write.
 *
 * This is an isolate-local exclusion. The Workspace Host remains the real filesystem owner; after
 * this Supervisor is evicted, only a Workspace Host-side protocol can prove that an old RPC stopped.
 */
const activeProvisions = new Map<string, ActiveProvision>();

/** Forget a tenant's in-flight plan after its Workspace Host has been reset. */
export function clearWorkspaceProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

function provisionIsStale(active: ActiveProvision, now: number): boolean {
  return now - active.startedAt > PROVISION_STALE_AFTER_MS;
}

function abortedProject(project: Project): ProvisioningOutcome {
  return Result.err({
    code: "provision-workspace-unavailable",
    projectId: project.id,
    step: "clone",
  });
}

function abortedHarness(): HarnessProvisioningOutcome {
  return Result.err({ code: "harness-provision-workspace-unavailable", step: "provision" });
}

/**
 * Run one operation while sharing the workspace exclusion with project and harness provisioning.
 * A caller waits for an older operation, then starts its own complete convergence plan.
 */
function provisionInWorkspace<T>(
  input: Readonly<{
    workspaceName: string;
    signal?: AbortSignal | undefined;
    run: () => Promise<T>;
    aborted: () => T;
  }>,
): Promise<T> {
  return (async () => {
    for (;;) {
      const active = activeProvisions.get(input.workspaceName);

      if (active !== undefined && !provisionIsStale(active, Date.now())) {
        const wait = await waitForActiveProvision(active, input.signal, "provision");

        if (wait === "aborted") return input.aborted();
        continue;
      }

      if (active !== undefined) clearStaleProvision(input.workspaceName, active);

      if (input.signal !== undefined && input.signal.aborted) return input.aborted();

      const operation = input.run();
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
  })();
}

function removeActiveProvision(workspaceName: string, active: ActiveProvision): void {
  if (activeProvisions.get(workspaceName) === active) activeProvisions.delete(workspaceName);
}

/**
 * A plan older than its whole command budget is presumed lost and forgotten. The Workspace Host
 * may still be running it, which is why this is worth a warning.
 */
function clearStaleProvision(workspaceName: string, active: ActiveProvision): void {
  activeProvisions.delete(workspaceName);
  logEvent("warn", "workspace.exclusion-stale", { heldForMs: Date.now() - active.startedAt });
}

type ProvisionWait = "settled" | "aborted" | "stale";

/** Who is waiting: another provision plan, or a turn about to use the workspace. */
type ProvisionWaiter = "provision" | "turn";

async function waitForActiveProvision(
  active: ActiveProvision,
  signal: AbortSignal | undefined,
  waiter: ProvisionWaiter,
): Promise<ProvisionWait> {
  const waitStartedAt = Date.now();
  const result = await settleActiveProvision(active, signal);

  logEvent(result === "stale" ? "warn" : "info", "workspace.exclusion-wait", {
    waiter,
    result,
    waitedMs: Date.now() - waitStartedAt,
  });

  return result;
}

function settleActiveProvision(
  active: ActiveProvision,
  signal: AbortSignal | undefined,
): Promise<ProvisionWait> {
  if (signal !== undefined && signal.aborted) return Promise.resolve("aborted");

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

/** Wait for the current workspace provision, without joining it or starting a replacement. */
export async function waitForWorkspaceProvision(
  workspaceName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  for (;;) {
    const active = activeProvisions.get(workspaceName);

    if (active === undefined) return signal?.aborted !== true;

    if (provisionIsStale(active, Date.now())) {
      clearStaleProvision(workspaceName, active);

      continue;
    }

    const wait = await waitForActiveProvision(active, signal, "turn");

    if (wait === "aborted") return false;

    if (wait === "settled") return true;
  }
}

/** Provision one project inside the tenant's workspace, then rewrite its managed instructions. */
export function provisionProjectWorkspace(
  input: ProvisionProjectWorkspaceInput,
): Promise<ProvisioningOutcome> {
  const resolved = resolveProject(input.projectId, input.catalog);

  if (!resolved.ok) {
    return Promise.resolve(Result.err({ code: "project-not-in-catalog", reason: resolved.reason }));
  }

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal: input.signal,
    aborted: () => abortedProject(resolved.project),
    run: () => provisionResolvedProject(input, resolved.project),
  });
}

/** Reconcile the editable harness checkout before a harness turn uses its working directory. */
export function provisionHarnessWorkspace(
  input: ProvisionHarnessWorkspaceInput,
): Promise<HarnessProvisioningOutcome> {
  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal: input.signal,
    aborted: abortedHarness,
    run: () => provisionResolvedHarness(input),
  });
}

async function provisionResolvedProject(
  input: ProvisionProjectWorkspaceInput,
  project: Project,
): Promise<ProvisioningOutcome> {
  const host = input.namespace.getByName(input.workspaceName);

  for (const step of PROJECT_PROVISION_STEP_NAMES) {
    const ran = await timed(
      "workspace.provision-step",
      { plan: "project", projectId: project.id, step, method: "provision" },
      () => runProjectStep(host, project, step, input.signal),
      stepOutcome,
    );

    if (ran.isErr()) return Result.err(ran.error);
  }

  return Result.ok({ projectId: project.id, workspaceName: input.workspaceName });
}

async function provisionResolvedHarness(
  input: ProvisionHarnessWorkspaceInput,
): Promise<HarnessProvisioningOutcome> {
  const host = input.namespace.getByName(input.workspaceName);

  for (const step of HARNESS_PROVISION_STEP_NAMES) {
    const ran = await timed(
      "workspace.provision-step",
      {
        plan: "harness",
        step,
        method: step === "provision" ? "build" : "ensureManagedInstructions",
      },
      () => runHarnessStep(host, input.harnessCommit, step, input.signal),
      stepOutcome,
    );

    if (ran.isErr()) return Result.err(ran.error);
  }

  return Result.ok({ workspaceName: input.workspaceName });
}
