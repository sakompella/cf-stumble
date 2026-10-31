import type { Context } from "@earendil-works/chord/context";
import { FileError, type Result } from "@earendil-works/pi-durable/env";
import { shellQuote } from "../../shell-quote.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { execInWorkspace, type RunningCommands } from "./execution-env-exec.js";
import { TEMP_DIRECTORY, uniqueTempPath } from "./execution-env-files.js";
import { aborted, type ComputerWorkspace, type WorkspacePath } from "./execution-env-paths.js";

function operand(path: WorkspacePath): string {
  return shellQuote(`.${path.addressed}`);
}

async function run(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  script: string,
  path: WorkspacePath,
  context: Context,
): Promise<Result<void, FileError>> {
  let stderr = "";

  const ran = await execInWorkspace(
    workspace,
    running,
    script,
    {
      cwd: WORKSPACE_ROOT,
      onOutput: (text, _context, info) => {
        if (info.stream === "stderr") stderr += text;
      },
    },
    context,
  );

  if (!ran.ok) {
    if (ran.error.code === "aborted") return aborted(path.absolute);

    return {
      ok: false,
      error: new FileError("unknown", ran.error.message, path.absolute, ran.error),
    };
  }

  if (ran.value.exitCode === 0) return { ok: true, value: undefined };

  return {
    ok: false,
    error: new FileError("unknown", stderr.trim() || `exit ${ran.value.exitCode}`, path.absolute),
  };
}

export async function createTempDir(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  prefix: string | undefined,
  context: Context,
): Promise<Result<string, FileError>> {
  if (context.abortSignal?.aborted === true) return aborted();

  const path = uniqueTempPath(prefix ?? "tmp-");

  if (!path.ok) return path;

  const parent = shellQuote(`.${TEMP_DIRECTORY}`);
  const script = `mkdir -p ${parent} && mkdir ${operand(path.value)}`;
  const created = await run(workspace, running, script, path.value, context);

  return created.ok ? { ok: true, value: path.value.absolute } : created;
}
