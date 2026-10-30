import type { Context } from "@earendil-works/chord/context";
import { FileError, type Result } from "@earendil-works/pi-durable/env";
import { shellQuote } from "../../shell-quote.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { execInWorkspace, type RunningCommands } from "./execution-env-exec.js";
import { lstat, open, TEMP_DIRECTORY, uniqueTempPath } from "./execution-env-files.js";
import { aborted, type ComputerWorkspace, type WorkspacePath } from "./execution-env-paths.js";

/**
 * The capability can read, write, and stat, but has no rename, remove, or mkdir, so these run as
 * POSIX commands in the container. Paths are relative to the workspace root, which is the
 * command's working directory.
 */
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

/** `mv -T` (GNU, as in the workspace image) replaces a destination the way rename(2) does. */
export async function renameFile(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  sourcePath: string,
  destinationPath: string,
  context: Context,
): Promise<Result<void, FileError>> {
  const source = open(workspace, sourcePath, context);

  if (!source.ok) return source;

  const destination = open(workspace, destinationPath, context);

  if (!destination.ok) return destination;

  const existing = await lstat(workspace, source.value);

  if (!existing.ok) return existing;

  const script = `mv -f -T ${operand(source.value)} ${operand(destination.value)}`;

  return run(workspace, running, script, source.value, context);
}

export async function remove(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  path: string,
  options: { recursive?: boolean; force?: boolean } | undefined,
  context: Context,
): Promise<Result<void, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const existing = await lstat(workspace, opened.value);

  if (!existing.ok) {
    const missing = existing.error.code === "not_found";

    return missing && options?.force === true ? { ok: true, value: undefined } : existing;
  }

  const recursive = options?.recursive === true;

  if (existing.value.kind === "directory" && !recursive) {
    return {
      ok: false,
      error: new FileError("is_directory", "Is a directory", opened.value.absolute),
    };
  }

  const script = `rm -f ${recursive ? "-r " : ""}${operand(opened.value)}`;

  return run(workspace, running, script, opened.value, context);
}

export function createDir(
  workspace: ComputerWorkspace,
  running: RunningCommands,
  path: string,
  options: { recursive?: boolean } | undefined,
  context: Context,
): Promise<Result<void, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return Promise.resolve(opened);

  const parents = options?.recursive === false ? "" : "-p ";
  const script = `mkdir ${parents}${operand(opened.value)}`;

  return run(workspace, running, script, opened.value, context);
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
