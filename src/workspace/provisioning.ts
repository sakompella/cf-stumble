// oxlint-disable max-lines, import/max-dependencies -- Project and harness provisioning share one workspace exclusion.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logEvent, logRedactedCause, timedEffect, type TimedOutcome } from "../diagnostics.js";
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
import type { ProjectRemovalWorkspaceHost } from "./project-removal.js";
import {
  WORKSPACE_RPC_TIMEOUT_MARGIN_MS,
  WORKSPACE_RPC_TIMEOUT_MS,
} from "../workspace-command-timeout.js";
import { workspaceRpc, type WorkspaceRpcFailed } from "./workspace-rpc.js";

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

export type ProjectRemovalWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectRemovalWorkspaceHost;
}>;

export type HarnessProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): HarnessProvisionWorkspaceHost;
}>;

/** The catalog does not name this project, so nothing was provisioned. */
class ProjectNotInCatalog extends Data.TaggedError("ProjectNotInCatalog")<{
  readonly reason: "invalid-project-id" | "unknown-project-id";
}> {
  get code(): "project-not-in-catalog" {
    return "project-not-in-catalog";
  }
}

/** A provisioning command ran and exited with a nonzero code. */
export class ProvisionStepFailed extends Data.TaggedError("ProvisionStepFailed")<{
  readonly projectId: ProjectId;
  readonly step: ProjectProvisionStepName;
  readonly exitCode: number;
}> {
  get code(): "provision-step-failed" {
    return "provision-step-failed";
  }
}

/** The workspace could not run a step, refused it, answered wrongly, or the turn ended first. */
export class ProvisionWorkspaceUnavailable extends Data.TaggedError(
  "ProvisionWorkspaceUnavailable",
)<{
  readonly projectId: ProjectId;
  readonly step: ProjectProvisionStepName;
}> {
  get code(): "provision-workspace-unavailable" {
    return "provision-workspace-unavailable";
  }
}

/** Why project provisioning stopped. */
export type ProjectProvisionProblem =
  | ProjectNotInCatalog
  | ProvisionStepFailed
  | ProvisionWorkspaceUnavailable;

type ProvisionedProjectWorkspace = Readonly<{
  projectId: ProjectId;
  workspaceName: string;
}>;

type HarnessProvisionStepName = "provision" | "instructions";

const HARNESS_PROVISION_STEP_NAMES: readonly HarnessProvisionStepName[] = [
  "provision",
  "instructions",
];

/** The harness checkout's reconcile command exited with a nonzero code. */
class HarnessProvisionStepFailed extends Data.TaggedError("HarnessProvisionStepFailed")<{
  readonly step: HarnessProvisionStepName;
  readonly exitCode: number;
}> {
  get code(): "harness-provision-step-failed" {
    return "harness-provision-step-failed";
  }
}

/** The workspace could not run a harness step, answered wrongly, or the turn ended first. */
class HarnessProvisionWorkspaceUnavailable extends Data.TaggedError(
  "HarnessProvisionWorkspaceUnavailable",
)<{ readonly step: HarnessProvisionStepName }> {
  get code(): "harness-provision-workspace-unavailable" {
    return "harness-provision-workspace-unavailable";
  }
}

type HarnessProvisionProblem = HarnessProvisionStepFailed | HarnessProvisionWorkspaceUnavailable;

type ProvisionedHarnessWorkspace = Readonly<{ workspaceName: string }>;

interface ProvisionProjectWorkspaceInput {
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  /** The client-supplied project id. The catalog resolves it before anything is provisioned. */
  readonly projectId: unknown;
  readonly catalog?: ProjectCatalog;
  readonly namespace: ProvisionWorkspaceNamespace;
  /** Stops the plan before another workspace RPC when the owning turn has ended. */
  readonly signal?: AbortSignal | undefined;
}

interface ProvisionHarnessWorkspaceInput {
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
): Effect.Effect<WorkspaceResult, WorkspaceRpcFailed> {
  return workspaceRpc(
    { method: "provision", step },
    () =>
      host.provision({
        kind: "provision-project",
        projectId: project.id,
        repositoryUrl: project.repositoryUrl,
        step,
      }),
    WORKSPACE_RPC_TIMEOUT_MS,
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

function runProjectStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectProvisionStepName,
  signal: AbortSignal | undefined,
): Effect.Effect<ProjectProvisionStepName, ProjectProvisionProblem> {
  const projectId = project.id;
  const unavailable = new ProvisionWorkspaceUnavailable({ projectId, step });

  return Effect.gen(function* () {
    if (signal !== undefined && signal.aborted) return yield* unavailable;

    const startedAt = Date.now();

    const result = yield* runProjectHostStep(host, project, step).pipe(
      Effect.catchTag("WorkspaceRpcFailed", ({ cause }) => {
        if (step === "clone") logClone(projectId, startedAt, undefined, "unavailable");
        logRedactedCause(
          `project-provision.${step}: provision-workspace-unavailable (${projectId})`,
          cause,
        );

        return Effect.fail(unavailable);
      }),
    );

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
      return yield* unavailable;
    }

    if (result.result.kind === "command" && result.result.exitCode !== 0) {
      return yield* new ProvisionStepFailed({
        projectId,
        step,
        exitCode: result.result.exitCode,
      });
    }

    return step;
  });
}

function runHarnessHostStep(
  host: HarnessProvisionWorkspaceHost,
  harnessCommit: HarnessCommit,
  step: HarnessProvisionStepName,
): Effect.Effect<WorkspaceResult, WorkspaceRpcFailed> {
  return step === "provision"
    ? workspaceRpc(
        { method: "build", step },
        () => host.build({ kind: "build-step", harnessCommit, step }),
        WORKSPACE_RPC_TIMEOUT_MS,
      )
    : workspaceRpc(
        { method: "ensureManagedInstructions", step },
        () => host.ensureManagedInstructions(),
        WORKSPACE_RPC_TIMEOUT_MS,
      );
}

function runHarnessStep(
  host: HarnessProvisionWorkspaceHost,
  harnessCommit: HarnessCommit,
  step: HarnessProvisionStepName,
  signal: AbortSignal | undefined,
): Effect.Effect<HarnessProvisionStepName, HarnessProvisionProblem> {
  const unavailable = new HarnessProvisionWorkspaceUnavailable({ step });

  return Effect.gen(function* () {
    if (signal !== undefined && signal.aborted) return yield* unavailable;

    const result = yield* runHarnessHostStep(host, harnessCommit, step).pipe(
      Effect.catchTag("WorkspaceRpcFailed", ({ cause }) => {
        logRedactedCause(`harness-provision.${step}: workspace-unavailable`, cause);

        return Effect.fail(unavailable);
      }),
    );

    if ((signal !== undefined && signal.aborted) || !result.ok) return yield* unavailable;

    if (step === "provision") {
      if (result.result.kind !== "command") return yield* unavailable;

      if (result.result.exitCode !== 0) {
        return yield* new HarnessProvisionStepFailed({ step, exitCode: result.result.exitCode });
      }
    } else if (result.result.kind !== "written") {
      return yield* unavailable;
    }

    return step;
  });
}

/** A step's log outcome: `ok`, or the problem code and, for a command, its exit code. */
function stepOutcome<Step>(
  ran: Result.Result<Step, ProjectProvisionProblem | HarnessProvisionProblem>,
): TimedOutcome {
  if (Result.isSuccess(ran)) return { outcome: "ok" };

  const problem = ran.failure;

  return {
    outcome: problem.code,
    level: "warn",
    fields: "exitCode" in problem ? { exitCode: problem.exitCode } : {},
  };
}

type ActiveProvision = Readonly<{
  operation: Promise<unknown>;
  startedAt: number;
}>;

const PROVISION_PLAN_STEP_COUNT = Math.max(
  PROJECT_PROVISION_STEP_NAMES.length,
  HARNESS_PROVISION_STEP_NAMES.length,
);

export const PROVISION_STALE_AFTER_MS =
  PROVISION_PLAN_STEP_COUNT * WORKSPACE_RPC_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

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

/**
 * Run one operation while sharing the workspace exclusion with project and harness provisioning.
 * A caller waits for an older operation, then starts its own complete convergence plan.
 *
 * The plan is uninterruptible. Its Workspace Host RPCs cannot be recalled once sent, so the
 * exclusion is held until the plan has actually settled, never only until its caller stopped
 * waiting.
 */
function provisionInWorkspace<A, E>(
  input: Readonly<{
    workspaceName: string;
    signal?: AbortSignal | undefined;
    run: Effect.Effect<A, E>;
    aborted: E;
  }>,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvisions.get(input.workspaceName);

      if (active !== undefined && !provisionIsStale(active, Date.now())) {
        const wait = yield* Effect.promise(() =>
          waitForActiveProvision(active, input.signal, "provision"),
        );

        if (wait === "aborted") return yield* Effect.fail(input.aborted);
        continue;
      }

      if (active !== undefined) clearStaleProvision(input.workspaceName, active);

      if (input.signal !== undefined && input.signal.aborted) {
        return yield* Effect.fail(input.aborted);
      }

      const settled = { settle: (): void => {} };

      const tracked: ActiveProvision = {
        operation: new Promise<void>((resolve) => {
          settled.settle = resolve;
        }),
        startedAt: Date.now(),
      };

      activeProvisions.set(input.workspaceName, tracked);

      return yield* Effect.uninterruptible(input.run).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            removeActiveProvision(input.workspaceName, tracked);
            settled.settle();
          }),
        ),
      );
    }
  });
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

/**
 * Wait for the current workspace provision, without joining it or starting a replacement. It
 * answers whether the caller may go on: `false` when the signal aborted the wait.
 */
export function waitForWorkspaceProvision(
  workspaceName: string,
  signal?: AbortSignal,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvisions.get(workspaceName);

      if (active === undefined) return signal?.aborted !== true;

      if (provisionIsStale(active, Date.now())) {
        clearStaleProvision(workspaceName, active);

        continue;
      }

      const wait = yield* Effect.promise(() => waitForActiveProvision(active, signal, "turn"));

      if (wait === "aborted") return false;

      if (wait === "settled") return true;
    }
  });
}

/** Provision one project inside the tenant's workspace, then rewrite its managed instructions. */
export function provisionProjectWorkspace(
  input: ProvisionProjectWorkspaceInput,
): Effect.Effect<ProvisionedProjectWorkspace, ProjectProvisionProblem> {
  const resolved = resolveProject(input.projectId, input.catalog);

  if (!resolved.ok) return Effect.fail(new ProjectNotInCatalog({ reason: resolved.reason }));

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal: input.signal,
    aborted: new ProvisionWorkspaceUnavailable({ projectId: resolved.project.id, step: "clone" }),
    run: provisionResolvedProject(input, resolved.project),
  });
}

/** Reconcile the editable harness checkout before a harness turn uses its working directory. */
export function provisionHarnessWorkspace(
  input: ProvisionHarnessWorkspaceInput,
): Effect.Effect<ProvisionedHarnessWorkspace, HarnessProvisionProblem> {
  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal: input.signal,
    aborted: new HarnessProvisionWorkspaceUnavailable({ step: "provision" }),
    run: provisionResolvedHarness(input),
  });
}

function provisionResolvedProject(
  input: ProvisionProjectWorkspaceInput,
  project: Project,
): Effect.Effect<ProvisionedProjectWorkspace, ProjectProvisionProblem> {
  return Effect.gen(function* () {
    const host = input.namespace.getByName(input.workspaceName);

    for (const step of PROJECT_PROVISION_STEP_NAMES) {
      yield* runProjectStep(host, project, step, input.signal).pipe(
        timedEffect(
          "workspace.provision-step",
          { plan: "project", projectId: project.id, step, method: "provision" },
          stepOutcome,
        ),
      );
    }

    return { projectId: project.id, workspaceName: input.workspaceName };
  });
}

function provisionResolvedHarness(
  input: ProvisionHarnessWorkspaceInput,
): Effect.Effect<ProvisionedHarnessWorkspace, HarnessProvisionProblem> {
  return Effect.gen(function* () {
    const host = input.namespace.getByName(input.workspaceName);

    for (const step of HARNESS_PROVISION_STEP_NAMES) {
      yield* runHarnessStep(host, input.harnessCommit, step, input.signal).pipe(
        timedEffect(
          "workspace.provision-step",
          {
            plan: "harness",
            step,
            method: step === "provision" ? "build" : "ensureManagedInstructions",
          },
          stepOutcome,
        ),
      );
    }

    return { workspaceName: input.workspaceName };
  });
}
