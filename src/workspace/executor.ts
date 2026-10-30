import * as Effect from "effect/Effect";
import { isTimeoutFailure, logRedactedCause } from "../diagnostics.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceResult } from "./decisions.js";
import { parseHarnessBuildRequest, planHarnessBuildRequest } from "./harness-build.js";
import {
  cloneMarkersAreDurable,
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
} from "./project-provision.js";
import {
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  removalIsDurable,
} from "./project-removal.js";
import type { HarnessBuildConfiguration } from "../harness-build.js";
import {
  answerFailures,
  workspaceEffects,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
  type WorkspaceOperations,
} from "./operations.js";

export {
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "./operations.js";

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
): Effect.Effect<WorkspaceResult, WorkspaceFault> {
  return runPlannedCommand(operations, plan).pipe(
    Effect.map((output): WorkspaceResult => ({
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A thrown value can be anything; it only picks a log label.
  unavailableLabel: (thrown: unknown) => string,
): (work: Effect.Effect<WorkspaceResult, WorkspaceFault>) => Effect.Effect<WorkspaceResult> {
  return answerFailures<WorkspaceResult>((thrown) => {
    if (thrown instanceof WorkspaceSyncIncomplete) {
      logRedactedCause(`${context}: sync-incomplete`, thrown);

      return syncIncomplete();
    }

    logRedactedCause(`${context}: ${unavailableLabel(thrown)}`, thrown);

    return unavailable();
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A thrown value can be anything.
function timeoutOrUnavailable(thrown: unknown): string {
  return isTimeoutFailure(thrown) ? "timeout" : "workspace-unavailable";
}

/** Plans from the build configuration alone, so it can neither run a project command nor reach a project file. */
export function executeHarnessBuildRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    configuration: HarnessBuildConfiguration;
    request: unknown;
  }>,
): Effect.Effect<WorkspaceResult> {
  const parsed = parseHarnessBuildRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.suspend(() =>
    executePlan(
      workspaceEffects(input.operations),
      planHarnessBuildRequest(input.configuration, parsed),
    ),
  ).pipe(
    answerFailures((thrown): WorkspaceResult => {
      logRedactedCause(
        `workspace.harness-build.${parsed.kind}: ${timeoutOrUnavailable(thrown)}`,
        thrown,
      );

      return unavailable();
    }),
  );
}

export function executeProjectProvisionRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    request: unknown;
  }>,
): Effect.Effect<WorkspaceResult> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const operations = workspaceEffects(input.operations);

    const result = yield* executePlan(operations, planProjectProvisionRequest(parsed));

    const cloned =
      parsed.step === "clone" && result.ok && result.result.kind === "command"
        ? result.result.exitCode === 0
        : false;

    return cloned && !(yield* cloneMarkersAreDurable(operations, parsed.project))
      ? syncIncomplete()
      : result;
  }).pipe(
    answerDurableFailures(`workspace.provision-project.${parsed.step}`, timeoutOrUnavailable),
  );
}

export function executeProjectRemovalRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    request: unknown;
  }>,
): Effect.Effect<WorkspaceResult> {
  const parsed = parseProjectRemovalRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const operations = workspaceEffects(input.operations);
    const plan = planProjectRemovalRequest(parsed);
    const output = yield* runPlannedCommand(operations, plan);

    if (output.exitCode === 0 && !(yield* removalIsDurable(operations, parsed.projectId))) {
      return syncIncomplete();
    }

    return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } } as const;
  }).pipe(answerDurableFailures("workspace.project-removal", () => "workspace-unavailable"));
}
