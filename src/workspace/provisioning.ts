// oxlint-disable max-lines, import/max-dependencies -- Project and harness provisioning share one workspace exclusion.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import type { ProjectProvisionStepName } from "../project-provision.js";
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

type ManagedInstructionsWorkspaceHost = Readonly<{
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

class ProjectNotInCatalog extends Data.TaggedError("ProjectNotInCatalog")<{
  readonly reason: "invalid-project-id" | "unknown-project-id";
}> {
  get code(): "project-not-in-catalog" {
    return "project-not-in-catalog";
  }
}

export class ProvisionStepFailed extends Data.TaggedError("ProvisionStepFailed")<{
  readonly projectId: ProjectId;
  readonly step: ProjectProvisionStepName;
  readonly exitCode: number;
}> {
  get code(): "provision-step-failed" {
    return "provision-step-failed";
  }
}

export class ProvisionWorkspaceUnavailable extends Data.TaggedError(
  "ProvisionWorkspaceUnavailable",
)<{
  readonly projectId: ProjectId;
  readonly step: ProjectPlanStepName;
}> {
  get code(): "provision-workspace-unavailable" {
    return "provision-workspace-unavailable";
  }
}

export type ProjectProvisionProblem =
  | ProjectNotInCatalog
  | ProvisionStepFailed
  | ProvisionWorkspaceUnavailable;

type ProvisionedProjectWorkspace = Readonly<{
  projectId: ProjectId;
  workspaceName: string;
}>;

type ProjectPlanStepName = ProjectProvisionStepName | "instructions";

const PROJECT_PLAN_STEP_NAMES: readonly ProjectPlanStepName[] = ["clone", "instructions"];

type HarnessProvisionStepName = "provision" | "instructions";

const HARNESS_PROVISION_STEP_NAMES: readonly HarnessProvisionStepName[] = [
  "provision",
  "instructions",
];

class HarnessProvisionStepFailed extends Data.TaggedError("HarnessProvisionStepFailed")<{
  readonly step: HarnessProvisionStepName;
  readonly exitCode: number;
}> {
  get code(): "harness-provision-step-failed" {
    return "harness-provision-step-failed";
  }
}

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
  readonly workspaceName: string;
  readonly projectId: string;
  readonly catalog?: ProjectCatalog;
  readonly namespace: ProvisionWorkspaceNamespace;
  readonly signal?: AbortSignal | undefined;
}

interface ProvisionHarnessWorkspaceInput {
  readonly workspaceName: string;
  readonly harnessCommit: HarnessCommit;
  readonly namespace: HarnessProvisionWorkspaceNamespace;
  readonly signal?: AbortSignal | undefined;
}

const STEP_RESULT_KIND = {
  clone: "command",
  instructions: "written",
} as const satisfies Record<ProjectPlanStepName, "command" | "written">;

function writeManagedInstructions(
  host: ManagedInstructionsWorkspaceHost,
): Effect.Effect<WorkspaceResult, WorkspaceRpcFailed> {
  return workspaceRpc(() => host.ensureManagedInstructions(), WORKSPACE_RPC_TIMEOUT_MS);
}

function runProjectHostStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectPlanStepName,
): Effect.Effect<WorkspaceResult, WorkspaceRpcFailed> {
  return step === "instructions"
    ? writeManagedInstructions(host)
    : workspaceRpc(
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

function runProjectStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectPlanStepName,
  signal: AbortSignal | undefined,
): Effect.Effect<ProjectPlanStepName, ProjectProvisionProblem> {
  const projectId = project.id;
  const unavailable = new ProvisionWorkspaceUnavailable({ projectId, step });

  return Effect.gen(function* () {
    if (signal !== undefined && signal.aborted) return yield* unavailable;

    const result = yield* runProjectHostStep(host, project, step).pipe(
      Effect.catchTag("WorkspaceRpcFailed", ({ cause }) => {
        logRedactedCause(
          `project-provision.${step}: provision-workspace-unavailable (${projectId})`,
          cause,
        );

        return Effect.fail(unavailable);
      }),
    );

    if (
      (signal !== undefined && signal.aborted) ||
      !result.ok ||
      result.result.kind !== STEP_RESULT_KIND[step]
    ) {
      return yield* unavailable;
    }

    if (step === "clone" && result.result.kind === "command" && result.result.exitCode !== 0) {
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
        () => host.build({ kind: "build-step", harnessCommit, step }),
        WORKSPACE_RPC_TIMEOUT_MS,
      )
    : writeManagedInstructions(host);
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

type ActiveProvision = Readonly<{
  operation: Promise<unknown>;
  startedAt: number;
}>;

const PROVISION_PLAN_STEP_COUNT = Math.max(
  PROJECT_PLAN_STEP_NAMES.length,
  HARNESS_PROVISION_STEP_NAMES.length,
);

export const PROVISION_STALE_AFTER_MS =
  PROVISION_PLAN_STEP_COUNT * WORKSPACE_RPC_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

const activeProvisions = new Map<string, ActiveProvision>();

export function clearWorkspaceProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

function provisionIsStale(active: ActiveProvision, now: number): boolean {
  return now - active.startedAt > PROVISION_STALE_AFTER_MS;
}

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
        const wait = yield* Effect.promise(() => settleActiveProvision(active, input.signal));

        if (wait === "aborted") return yield* Effect.fail(input.aborted);
        continue;
      }

      if (active !== undefined) clearStaleProvision(input.workspaceName);

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

function clearStaleProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

type ProvisionWait = "settled" | "aborted" | "stale";

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

export function waitForWorkspaceProvision(
  workspaceName: string,
  signal?: AbortSignal,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvisions.get(workspaceName);

      if (active === undefined) return signal?.aborted !== true;

      if (provisionIsStale(active, Date.now())) {
        clearStaleProvision(workspaceName);

        continue;
      }

      const wait = yield* Effect.promise(() => settleActiveProvision(active, signal));

      if (wait === "aborted") return false;

      if (wait === "settled") return true;
    }
  });
}

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

    for (const step of PROJECT_PLAN_STEP_NAMES) {
      yield* runProjectStep(host, project, step, input.signal);
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
      yield* runHarnessStep(host, input.harnessCommit, step, input.signal);
    }

    return { workspaceName: input.workspaceName };
  });
}
