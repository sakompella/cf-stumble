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

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

/**
 * The only imperative operations the Workspace Host needs from Computer.
 *
 * `runCommand` takes an optional `stdin` because a secret belongs on standard input and nowhere
 * else: a command line is visible in a process list, and a file has to be created, read, and
 * removed on a filesystem that may not be the one the command runs on. Standard input reaches the
 * process directly, so nothing has to be cleaned up afterwards.
 */
export type WorkspaceOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(
    source: string,
    cwd: string,
    timeoutMs: number,
    stdin?: string,
  ): Promise<Readonly<CommandOutput>>;
}>;

export type CommandOutput = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Thrown by `runCommand` when the command ran but its container changes are not proven to be in
 * the durable workspace store. Only surfaces that need a durable result ask for that check.
 */
export class WorkspaceSyncIncomplete extends Error {
  override readonly name = "WorkspaceSyncIncomplete";
}

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

async function isSymlinkFree(operations: WorkspaceOperations, path: string): Promise<boolean> {
  for (const prefix of pathParts(path)) {
    if ((await operations.lstat(prefix)) === "symbolic-link") return false;
  }

  return true;
}

/** A command the server planned: its text, where it runs, and how long it may take. */
type PlannedCommand = Readonly<{ source: string; cwd: string; timeoutMs: number }>;

/**
 * Run one planned command and log it by `command`, the planned step's name, with its exit code and
 * duration. The command text and its output stay out of the log: the text names a repository and
 * the output is whatever a tool printed.
 */
export async function runLoggedCommand(
  operations: WorkspaceOperations,
  command: string,
  plan: PlannedCommand,
  options: Readonly<{ stdin?: string; requestId?: RequestId | undefined }> = {},
): Promise<CommandOutput> {
  const startedAt = Date.now();
  const output = await operations.runCommand(plan.source, plan.cwd, plan.timeoutMs, options.stdin);

  logEvent(output.exitCode === 0 ? "info" : "warn", "workspace.command", {
    ...requestIdFields(options.requestId),
    command,
    timeoutMs: plan.timeoutMs,
    exitCode: output.exitCode,
    durationMs: Date.now() - startedAt,
  });

  return output;
}

async function executePlan(
  operations: WorkspaceOperations,
  plan: WorkspacePlan,
  command: string,
): Promise<WorkspaceResult> {
  switch (plan.kind) {
    case "write-file": {
      if (!(await isSymlinkFree(operations, plan.path))) {
        return { ok: false, error: { code: "path-outside-root" } };
      }

      await operations.writeFile(plan.path, plan.content);

      return { ok: true, result: { kind: "written" } };
    }

    case "run-command": {
      const output = await runLoggedCommand(operations, command, plan);

      return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } };
    }

    default: {
      const exhaustive: never = plan;

      return exhaustive;
    }
  }
}

function cloneCommandOutput(output: CommandOutput): CommandOutput {
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
}

/**
 * The build surface's effect shell. It redacts Computer failures, preserves command exit codes,
 * and returns only plain structured-cloneable values. It plans from the build configuration
 * alone, so it can neither run a project command nor reach a project file.
 */
export async function executeHarnessBuildRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    configuration: HarnessBuildConfiguration;
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseHarnessBuildRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    return await executePlan(
      input.operations,
      planHarnessBuildRequest(input.configuration, parsed),
      `harness-build.${parsed.kind === "build-step" ? parsed.step : "output"}`,
    );
  } catch (cause) {
    logRedactedCause(
      `workspace.harness-build.${parsed.kind}: ${isTimeoutFailure(cause) ? "timeout" : "workspace-unavailable"}`,
      cause,
    );

    return unavailable();
  }
}

/**
 * The provisioning surface's effect shell. It is separate from the build shell above because it
 * plans from a catalog project rather than from a harness commit: a provision clones the
 * repository the catalog names and writes the managed instructions beside it, and a build can
 * reach neither. Everything a turn does afterwards goes through the project capability instead.
 */
export async function executeProjectProvisionRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    const result = await executePlan(
      input.operations,
      planProjectProvisionRequest(parsed),
      `provision-project.${parsed.step}`,
    );

    const cloned =
      parsed.step === "clone" && result.ok && result.result.kind === "command"
        ? result.result.exitCode === 0
        : false;

    return cloned && !(await cloneMarkersAreDurable(input.operations, parsed.project))
      ? syncIncomplete()
      : result;
  } catch (cause) {
    if (cause instanceof WorkspaceSyncIncomplete) {
      logRedactedCause(`workspace.provision-project.${parsed.step}: sync-incomplete`, cause);

      return syncIncomplete();
    }

    logRedactedCause(
      `workspace.provision-project.${parsed.step}: ${isTimeoutFailure(cause) ? "timeout" : "workspace-unavailable"}`,
      cause,
    );

    return unavailable();
  }
}

/** The removal shell accepts only a parsed project id and derives every path server-side. */
export async function executeProjectRemovalRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseProjectRemovalRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    const plan = planProjectRemovalRequest(parsed);
    const output = await runLoggedCommand(input.operations, "project-removal", plan);

    if (output.exitCode === 0 && !(await removalIsDurable(input.operations, parsed.projectId))) {
      return syncIncomplete();
    }

    return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } };
  } catch (cause) {
    if (cause instanceof WorkspaceSyncIncomplete) {
      logRedactedCause("workspace.project-removal: sync-incomplete", cause);

      return syncIncomplete();
    }

    logRedactedCause("workspace.project-removal: workspace-unavailable", cause);

    return unavailable();
  }
}
