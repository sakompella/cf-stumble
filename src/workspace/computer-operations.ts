import type { Workspace } from "@cloudflare/computer";
import type { CommandOutput, WorkspaceOperations, WorkspacePathKind } from "./executor.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Computer threw this value; the function narrows its documented error code.
function isNotFound(error: unknown): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: Computer errors are untrusted implementation values.
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

/** Adapts the private Computer workspace to the host's narrower operation port. */
export class ComputerWorkspaceOperations implements WorkspaceOperations {
  private readonly workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  async lstat(path: string): Promise<WorkspacePathKind | undefined> {
    try {
      const entry = await this.workspace.fs.lstat(path);
      if (entry.isSymbolicLink) return "symbolic-link";
      return entry.isDirectory ? "directory" : "file";
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  readFile(path: string): Promise<string> {
    return this.workspace.fs.readFile(path, "utf8");
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.workspace.fs.writeFile(path, content);
  }

  async runCommand(source: string, cwd: string): Promise<CommandOutput> {
    const execution = await this.workspace.runtime.exec(source, {
      backend: "container-shell",
      cwd,
      encoding: "utf8",
    });
    const result = await execution.result();
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
}
