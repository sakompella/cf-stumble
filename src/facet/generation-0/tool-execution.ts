import { applyUniqueEdit } from "./tools.js";
import type { WorkspaceCapability } from "./capabilities.js";
import type { ToolPlan } from "./tools.js";
import type { WorkspaceRequest, WorkspaceResult } from "../../workspace/index.js";

/** One shell invocation the turn performed, in the shape the Supervisor already parses. */
export type ExecutedCommand = Readonly<{
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * What one executed tool call reports back to the model. A failure is a tool error the model can
 * read and react to, never a thrown value that would end the turn.
 */
export type ToolOutcome = Readonly<{
  text: string;
  isError: boolean;
  commands: readonly ExecutedCommand[];
}>;

const NO_COMMANDS: readonly ExecutedCommand[] = [];

function failed(text: string): ToolOutcome {
  return { text, isError: true, commands: NO_COMMANDS };
}

function succeeded(text: string): ToolOutcome {
  return { text, isError: false, commands: NO_COMMANDS };
}

function unavailable(): WorkspaceResult {
  return { ok: false, error: { code: "workspace-unavailable" } };
}

/**
 * Every workspace call goes through here, so a rejected RPC, an evicted workspace host, or a
 * Computer failure becomes the same plain result as a refused request.
 */
async function ask(
  workspace: WorkspaceCapability,
  request: WorkspaceRequest,
): Promise<WorkspaceResult> {
  try {
    return await workspace.execute(request);
  } catch {
    return unavailable();
  }
}

function workspaceError(result: Extract<WorkspaceResult, { ok: false }>): ToolOutcome {
  return failed(`workspace error: ${result.error.code}`);
}

function commandOutcome(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): ToolOutcome {
  return {
    text: `${command} exited with ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    isError: false,
    commands: [{ command, stdout, stderr, exitCode }],
  };
}

async function readFile(
  workspace: WorkspaceCapability,
  path: string,
): Promise<
  Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; outcome: ToolOutcome }>
> {
  const result = await ask(workspace, { kind: "read-file", path });
  if (!result.ok) return { ok: false, outcome: workspaceError(result) };
  if (result.result.kind !== "file") {
    return {
      ok: false,
      outcome: failed(`workspace returned ${result.result.kind} for a file read`),
    };
  }

  return { ok: true, content: result.result.content };
}

async function runEdit(
  workspace: WorkspaceCapability,
  plan: Extract<ToolPlan, { kind: "edit-file" }>,
): Promise<ToolOutcome> {
  const read = await readFile(workspace, plan.path);
  if (!read.ok) return read.outcome;

  const edited = applyUniqueEdit(read.content, plan.oldText, plan.newText);
  if (!edited.ok) {
    return failed(
      edited.reason === "not-found"
        ? `old_text does not appear in ${plan.path}`
        : `old_text appears more than once in ${plan.path}`,
    );
  }

  const written = await ask(workspace, {
    kind: "write-file",
    path: plan.path,
    content: edited.content,
  });
  return written.ok ? succeeded(`edited ${plan.path}`) : workspaceError(written);
}

type WorkspacePlan = Exclude<ToolPlan, { kind: "unknown-tool" | "invalid-arguments" }>;

async function runWorkspacePlan(
  workspace: WorkspaceCapability,
  plan: WorkspacePlan,
): Promise<ToolOutcome> {
  switch (plan.kind) {
    case "read-file": {
      const read = await readFile(workspace, plan.path);
      return read.ok ? succeeded(read.content) : read.outcome;
    }
    case "write-file": {
      const written = await ask(workspace, plan);
      return written.ok ? succeeded(`wrote ${plan.path}`) : workspaceError(written);
    }
    case "list-files": {
      const listed = await ask(workspace, plan);
      if (!listed.ok) return workspaceError(listed);
      return listed.result.kind === "files"
        ? succeeded(listed.result.entries.join("\n"))
        : failed(`workspace returned ${listed.result.kind} for a directory listing`);
    }
    case "run-command": {
      const ran = await ask(workspace, plan);
      if (!ran.ok) return workspaceError(ran);
      return ran.result.kind === "command"
        ? commandOutcome(plan.command, ran.result.stdout, ran.result.stderr, ran.result.exitCode)
        : failed(`workspace returned ${ran.result.kind} for a command run`);
    }
    case "git-diff": {
      const diffed = await ask(workspace, plan);
      if (!diffed.ok) return workspaceError(diffed);
      return diffed.result.kind === "git-diff"
        ? commandOutcome(
            "git diff",
            diffed.result.stdout,
            diffed.result.stderr,
            diffed.result.exitCode,
          )
        : failed(`workspace returned ${diffed.result.kind} for a diff`);
    }
    case "edit-file":
      return runEdit(workspace, plan);
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

/**
 * Execute one planned tool call. Without a workspace capability the tools that need it report a
 * tool error, because a generation that cannot reach files still has to finish its turn.
 */
export function executeToolPlan(
  workspace: WorkspaceCapability | undefined,
  plan: ToolPlan,
): Promise<ToolOutcome> {
  if (plan.kind === "unknown-tool") {
    return Promise.resolve(failed(`no tool named ${plan.name}`));
  }
  if (plan.kind === "invalid-arguments") {
    return Promise.resolve(failed(`${plan.name} arguments were rejected: ${plan.detail}`));
  }
  if (workspace === undefined) {
    return Promise.resolve(failed("workspace error: workspace-unavailable"));
  }

  return runWorkspacePlan(workspace, plan);
}
