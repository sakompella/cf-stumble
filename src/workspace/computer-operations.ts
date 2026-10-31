import type {
  ExecSyncResult,
  Workspace,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeResult,
} from "@cloudflare/computer";
import {
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "./executor.js";
import { hasErrnoCode } from "./errno-code.js";

function isNotFound(cause: unknown): boolean {
  return hasErrnoCode(cause) && cause.code === "ENOENT";
}

type CommandSync = "require-complete" | "not-required";

function syncIsComplete(sync: ExecSyncResult): boolean {
  return sync.status === "complete" && sync.skipped.length === 0;
}

export function commandOutput(
  result: Pick<WorkspaceRuntimeResult<"utf8">, "stdout" | "stderr" | "exitCode" | "sync">,
  sync: CommandSync,
): CommandOutput {
  if (sync === "require-complete" && !syncIsComplete(result.sync)) {
    throw new WorkspaceSyncIncomplete(
      `post-command sync ${result.sync.status} (exit ${String(result.exitCode)}, skipped ${String(result.sync.skipped.length)})`,
    );
  }

  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

export class ComputerWorkspaceOperations implements WorkspaceOperations {
  private readonly workspace: Workspace;
  private readonly sync: CommandSync;

  constructor(workspace: Workspace, sync: CommandSync) {
    this.workspace = workspace;
    this.sync = sync;
  }

  async lstat(path: string): Promise<WorkspacePathKind | undefined> {
    try {
      const entry = await this.workspace.fs.lstat(path);

      if (entry.isSymbolicLink) return "symbolic-link";

      return entry.isDirectory ? "directory" : "file";
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
  }

  readFile(path: string): Promise<string> {
    return this.workspace.fs.readFile(path, "utf8");
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.workspace.fs.writeFile(path, content);
  }

  async runCommand(
    source: string,
    cwd: string,
    timeoutMs: number,
    stdin?: string,
  ): Promise<CommandOutput> {
    const options: WorkspaceRuntimeExecOptions<"utf8"> = {
      backend: "container-shell",
      cwd,
      encoding: "utf8",
      timeoutMs,
    };

    if (stdin !== undefined) options.stdin = stdin;
    const execution = await this.workspace.runtime.exec(source, options);

    return commandOutput(await execution.result(), this.sync);
  }
}
