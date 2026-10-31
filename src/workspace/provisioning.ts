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
import { provisionInWorkspace } from "./provision-exclusion.js";

export { PROVISION_STALE_AFTER_MS } from "./provision-exclusion.js";

export type { HarnessProvisionWorkspaceHost, ProvisionWorkspaceHost } from "./provision-plan.js";

import {
  HARNESS_PROVISION_STEP_NAMES,
  PROJECT_PLAN_STEP_NAMES,
  provisionRpc,
  writeManagedInstructions,
  type HarnessProvisionStepName,
  type HarnessProvisionWorkspaceHost,
  type HarnessProvisionWorkspaceNamespace,
  type ProjectPlanStepName,
  type ProvisionRpc,
  type ProvisionWorkspaceHost,
  type ProvisionWorkspaceNamespace,
} from "./provision-plan.js";

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

function runProjectHostStep(
  host: ProvisionWorkspaceHost,
  project: Project,
  step: ProjectPlanStepName,
): ProvisionRpc {
  return step === "instructions"
    ? writeManagedInstructions(host)
    : provisionRpc(() =>
        host.provision({
          kind: "provision-project",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
          step,
        }),
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
): ProvisionRpc {
  return step === "provision"
    ? provisionRpc(() => host.build({ kind: "build-step", harnessCommit, step }))
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
