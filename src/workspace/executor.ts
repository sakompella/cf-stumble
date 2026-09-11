import type { WorkspaceFailure, WorkspacePlan, WorkspaceResult } from "./decisions.js";
import { parseHarnessBuildRequest, planHarnessBuildRequest } from "./harness-build.js";
import { parseProjectProvisionRequest, planProjectProvisionRequest } from "./project-provision.js";
import type { HarnessBuildConfiguration } from "../harness-build.js";

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

/** The only imperative operations the Workspace Host needs from Computer. */
export type WorkspaceOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(source: string, cwd: string, timeoutMs: number): Promise<Readonly<CommandOutput>>;
}>;

export type CommandOutput = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

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

async function executePlan(
  operations: WorkspaceOperations,
  plan: WorkspacePlan,
): Promise<WorkspaceResult> {
  switch (plan.kind) {
    case "read-file": {
      if (!(await isSymlinkFree(operations, plan.path))) {
        return { ok: false, error: { code: "path-outside-root" } };
      }

      return { ok: true, result: { kind: "file", content: await operations.readFile(plan.path) } };
    }

    case "write-file": {
      if (!(await isSymlinkFree(operations, plan.path))) {
        return { ok: false, error: { code: "path-outside-root" } };
      }

      await operations.writeFile(plan.path, plan.content);

      return { ok: true, result: { kind: "written" } };
    }

    case "run-command": {
      const output = await operations.runCommand(plan.source, plan.cwd, plan.timeoutMs);

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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public build request is parsed at this boundary.
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseHarnessBuildRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    return await executePlan(
      input.operations,
      planHarnessBuildRequest(input.configuration, parsed),
    );
  } catch {
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public provision request is parsed at this boundary.
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseProjectProvisionRequest(input.request);

  if ("ok" in parsed) return parsed;

  try {
    return await executePlan(input.operations, planProjectProvisionRequest(parsed));
  } catch {
    return unavailable();
  }
}
