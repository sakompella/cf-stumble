import type {
  WorkspaceConfiguration,
  WorkspaceFailure,
  WorkspacePlan,
  WorkspaceResult,
} from "./decisions.js";
import { parseWorkspaceRequest, planWorkspaceRequest } from "./decisions.js";
import { parseHarnessBuildRequest, planHarnessBuildRequest } from "./harness-build.js";
import { parseProjectProvisionRequest, planProjectProvisionRequest } from "./project-provision.js";
import type { HarnessBuildConfiguration } from "../harness-build.js";

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

/** The only imperative operations the Workspace Host needs from Computer. */
export type WorkspaceOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<readonly string[]>;
  runCommand(source: string, cwd: string): Promise<Readonly<CommandOutput>>;
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
    case "list-files": {
      if (!(await isSymlinkFree(operations, plan.path))) {
        return { ok: false, error: { code: "path-outside-root" } };
      }
      const entries = await operations.listFiles(plan.path);
      return { ok: true, result: { kind: "files", entries: [...entries] } };
    }
    case "run-command": {
      const output = await operations.runCommand(plan.source, plan.cwd);
      return { ok: true, result: { kind: "command", ...cloneCommandOutput(output) } };
    }
    case "git-diff": {
      const output = await operations.runCommand("git diff --no-ext-diff", plan.cwd);
      return { ok: true, result: { kind: "git-diff", ...cloneCommandOutput(output) } };
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
 * Thin effect shell around the pure parse and planning functions. It redacts Computer failures,
 * preserves command exit codes, and returns only plain structured-cloneable values.
 */
export async function executeWorkspaceRequest(
  input: Readonly<{
    operations: WorkspaceOperations;
    configuration: WorkspaceConfiguration;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public request is parsed at this boundary.
    request: unknown;
  }>,
): Promise<WorkspaceResult> {
  const parsed = parseWorkspaceRequest(input.request);
  if ("ok" in parsed) return parsed;
  const plan = planWorkspaceRequest(input.configuration, parsed);
  if (!("kind" in plan)) return plan;

  try {
    return await executePlan(input.operations, plan);
  } catch {
    return unavailable();
  }
}

/**
 * The build surface's effect shell. It is deliberately separate from the project shell above: it
 * plans from the build configuration alone, so it can neither run a project command nor reach a
 * project file, and the project shell can never run a build step.
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
 * The provisioning surface's effect shell. It is separate from the project shell for the reason
 * the project shell cannot host it: `planWorkspaceRequest` runs only commands that are keys of
 * `configuration.commands`, and the project's one command is the check the user's repository
 * defines. Provisioning is a capability alongside that check, not another entry in it.
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
