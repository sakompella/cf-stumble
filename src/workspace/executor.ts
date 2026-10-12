import * as Effect from "effect/Effect";
import {
  isTimeoutFailure,
  logEvent,
  logRedactedCause,
  requestIdFields,
  type RequestId,
} from "../diagnostics.js";
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

function pathParts(path: string): string[] {
  const parts = path.split("/");
  const prefixes: string[] = [];
  let current = "";

  for (const part of parts) {
    if (part === "") continue;
    current += `/${part}`;
    prefixes.push(current);
  }

  return prefixes;
}

function isSymlinkFree(
  operations: WorkspaceEffects,
  path: string,
): Effect.Effect<boolean, WorkspaceFault> {
  return Effect.gen(function* () {
    for (const prefix of pathParts(path)) {
      if ((yield* operations.lstat(prefix)) === "symbolic-link") return false;
    }

    return true;
  });
}

/** A command the server planned: its text, where it runs, and how long it may take. */
type PlannedCommand = Readonly<{ source: string; cwd: string; timeoutMs: number }>;

/**
 * Run one planned command and log it by `command`, the planned step's name, with its exit code and
 * duration. The command text and its output stay out of the log: the text names a repository and
 * the output is whatever a tool printed.
 */
export function runLoggedCommand(
  operations: WorkspaceEffects,
  command: string,
  plan: PlannedCommand,
  options: Readonly<{ stdin?: string; requestId?: RequestId | undefined }> = {},
): Effect.Effect<CommandOutput, WorkspaceFault> {
  return Effect.suspend(() => {
    const startedAt = Date.now();

    return operations.runCommand(plan.source, plan.cwd, plan.timeoutMs, options.stdin).pipe(
      Effect.tap((output) =>
        Effect.sync(() => {
          logEvent(output.exitCode === 0 ? "info" : "warn", "workspace.command", {
            ...requestIdFields(options.requestId),
            command,
            timeoutMs: plan.timeoutMs,
            exitCode: output.exitCode,
            durationMs: Date.now() - startedAt,
          });
        }),
      ),
    );
  });
}

function executePlan(
  operations: WorkspaceEffects,
  plan: WorkspacePlan,
  command: string,
): Effect.Effect<WorkspaceResult, WorkspaceFault> {
  switch (plan.kind) {
    case "write-file":
      return Effect.gen(function* () {
        if (!(yield* isSymlinkFree(operations, plan.path))) {
          return { ok: false, error: { code: "path-outside-root" } } as const;
        }

        yield* operations.writeFile(plan.path, plan.content);

        return { ok: true, result: { kind: "written" } } as const;
      });

    case "run-command":
      return runLoggedCommand(operations, command, plan).pipe(
        Effect.map((output): WorkspaceResult => ({
          ok: true,
          result: { kind: "command", ...cloneCommandOutput(output) },
        })),
      );

    default: {
      const exhaustive: never = plan;

      return exhaustive;
    }
  }
}

function cloneCommandOutput(output: CommandOutput): CommandOutput {
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
}

/** A surface's work, answered `workspace-sync-incomplete` or `workspace-unavailable` on failure. */
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

/**
 * The build surface's effect shell. It redacts Computer failures, preserves command exit codes,
 * and returns only plain structured-cloneable values. It plans from the build configuration
 * alone, so it can neither run a project command nor reach a project file.
 */
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
      `harness-build.${parsed.kind === "build-step" ? parsed.step : "output"}`,
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

/**
 * The provisioning surface's effect shell. It is separate from the build shell above because it
 * plans from a catalog project rather than from a harness commit: a provision clones the
 * repository the catalog names and writes the managed instructions beside it, and a build can
 * reach neither. Everything a turn does afterwards goes through the project capability instead.
 */
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

    const result = yield* executePlan(
      operations,
      planProjectProvisionRequest(parsed),
      `provision-project.${parsed.step}`,
    );

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

/** The removal shell accepts only a parsed project id and derives every path server-side. */
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
    const output = yield* runLoggedCommand(operations, "project-removal", plan);

    if (output.exitCode === 0 && !(yield* removalIsDurable(operations, parsed.projectId))) {
      return syncIncomplete();
    }

    return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } } as const;
  }).pipe(answerDurableFailures("workspace.project-removal", () => "workspace-unavailable"));
}
