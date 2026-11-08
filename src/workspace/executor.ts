import * as Effect from "effect/Effect";
import { isTimeoutFailure, logEvent, logRedactedCause } from "../diagnostics.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceCommandResult } from "./decisions.js";
import { parseHarnessBuildRequest, planHarnessBuildRequest } from "./harness-build.js";
import {
  cloneMarkersAreDurable,
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "./project-provision.js";
import {
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  removalIsDurable,
  type ProjectRemovalRequest,
} from "./project-removal.js";
import type { HarnessBuildConfiguration, HarnessBuildRequest } from "../harness-build.js";
import type { Project } from "../project-catalog.js";
import {
  answerFailures,
  WorkspaceSyncIncomplete,
  WorkspaceUnavailable,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
} from "./operations.js";

export { type CommandOutput, type WorkspaceEffects, type WorkspaceFault } from "./operations.js";

function syncIncomplete(): WorkspaceFailure {
  return { ok: false, error: { code: "workspace-sync-incomplete" } };
}

function unavailable(): WorkspaceFailure {
  return { ok: false, error: { code: "workspace-unavailable" } };
}

type PlannedCommand = Readonly<{ source: string; cwd: string; timeoutMs: number }>;

export function runPlannedCommand(
  operations: WorkspaceEffects,
  plan: PlannedCommand,
  stdin?: string,
): Effect.Effect<CommandOutput, WorkspaceFault> {
  return operations.runCommand(plan.source, plan.cwd, plan.timeoutMs, stdin);
}

function executePlan(
  operations: WorkspaceEffects,
  plan: WorkspacePlan,
): Effect.Effect<WorkspaceCommandResult, WorkspaceFault> {
  return runPlannedCommand(operations, plan).pipe(
    Effect.map((output): WorkspaceCommandResult => ({
      ok: true,
      result: { kind: "command", ...cloneCommandOutput(output) },
    })),
  );
}

function cloneCommandOutput(output: CommandOutput): CommandOutput {
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
}

function answerDurableFailures(
  context: string,
  unavailableLabel: (cause: unknown) => string,
): (
  work: Effect.Effect<WorkspaceCommandResult, WorkspaceFault>,
) => Effect.Effect<WorkspaceCommandResult> {
  return answerFailures<WorkspaceCommandResult>((cause) => {
    if (cause instanceof WorkspaceSyncIncomplete) {
      logRedactedCause(`${context}: sync-incomplete`, cause);

      return syncIncomplete();
    }

    logRedactedCause(`${context}: ${unavailableLabel(cause)}`, cause);

    return unavailable();
  });
}

function timeoutOrUnavailable(cause: unknown): string {
  return isTimeoutFailure(cause) ? "timeout" : "workspace-unavailable";
}

export function executeHarnessBuildRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    configuration: HarnessBuildConfiguration;
    request: HarnessBuildRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseHarnessBuildRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.suspend(() =>
    executePlan(input.operations, planHarnessBuildRequest(input.configuration, parsed)),
  ).pipe(
    answerFailures((cause): WorkspaceCommandResult => {
      logRedactedCause(
        `workspace.harness-build.${parsed.kind}: ${timeoutOrUnavailable(cause)}`,
        cause,
      );

      return unavailable();
    }),
  );
}

function isolateCloned(
  operations: WorkspaceEffects,
  project: Project,
  clone: (project: Project) => Effect.Effect<void, WorkspaceFault>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (yield* cloneMarkersAreDurable(operations, project)) return true;

    yield* clone(project);

    const durable = yield* cloneMarkersAreDurable(operations, project);

    if (!durable) logCloneFallback("the clone ran but its markers are missing");

    return durable;
  }).pipe(
    Effect.catch((fault) =>
      Effect.sync(() => {
        logCloneFallback(faultReason(fault));

        return false;
      }),
    ),
  );
}

function logCloneFallback(reason: string): void {
  logEvent("warn", "workspace.isolate-clone.fell-back", { reason });
}

function faultReason(fault: WorkspaceFault): string {
  const cause = fault instanceof WorkspaceUnavailable ? fault.cause : fault;

  return cause instanceof Error ? cause.message : String(cause);
}

export function executeProjectProvisionRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    request: ProjectProvisionRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const { operations } = input;
    const { cloneProject } = operations;

    if (
      cloneProject !== undefined &&
      (yield* isolateCloned(operations, parsed, (project) =>
        cloneProject.call(operations, project),
      ))
    ) {
      return {
        ok: true,
        result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
      } as const;
    }

    const output = yield* runPlannedCommand(operations, planProjectProvisionRequest(parsed));

    if (output.exitCode === 0 && !(yield* cloneMarkersAreDurable(operations, parsed))) {
      return syncIncomplete();
    }

    return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } } as const;
  }).pipe(answerDurableFailures("workspace.provision-project.clone", timeoutOrUnavailable));
}

export function executeProjectRemovalRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    request: ProjectRemovalRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseProjectRemovalRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const { operations } = input;
    const plan = planProjectRemovalRequest(parsed);
    const output = yield* runPlannedCommand(operations, plan);

    if (output.exitCode === 0 && !(yield* removalIsDurable(operations, parsed.projectId))) {
      return syncIncomplete();
    }

    return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } } as const;
  }).pipe(answerDurableFailures("workspace.project-removal", () => "workspace-unavailable"));
}
