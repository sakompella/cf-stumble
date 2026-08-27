import {
  parseWorkspacePath,
  type ExecuteCommandOptions,
  type Workspace,
  type WorkspaceCommandResult,
  type WorkspaceFileContent,
  type WorkspacePath,
} from "./types.js";

export type MemoryWorkspaceFile = {
  readonly path: string;
  readonly content: WorkspaceFileContent;
};

export type MemoryCommandExecutor = (
  command: string,
  options: ExecuteCommandOptions,
) => WorkspaceCommandResult | Promise<WorkspaceCommandResult>;

export type InMemoryWorkspaceOptions = {
  readonly files?: readonly MemoryWorkspaceFile[];
  readonly executeCommand?: MemoryCommandExecutor;
};

function cloneContent(content: WorkspaceFileContent): WorkspaceFileContent {
  return isTextContent(content) ? content : content.slice();
}

function isTextContent(content: WorkspaceFileContent): content is string {
  return typeof content === "string";
}

/** A deterministic Workspace for unit tests; it does not interpret shell commands. */
export class InMemoryWorkspace implements Workspace {
  private readonly files = new Map<WorkspacePath, WorkspaceFileContent>();
  private readonly executeCommand: MemoryCommandExecutor;

  constructor(options: InMemoryWorkspaceOptions = {}) {
    this.executeCommand =
      options.executeCommand ??
      (() => ({ status: "completed", exitCode: 0, stdout: "", stderr: "" }));

    for (const file of options.files ?? []) {
      // Fixture paths come from trusted setup code, so an invalid one is a mistake in the caller
      // rather than a condition to report; unwrap panics and names the offending path.
      const path = parseWorkspacePath(file.path).unwrap(
        `InMemoryWorkspace was given an invalid fixture path: ${JSON.stringify(file.path)}`,
      );
      if (this.files.has(path)) {
        throw new TypeError(`duplicate workspace file: ${JSON.stringify(file.path)}`);
      }
      this.files.set(path, cloneContent(file.content));
    }
  }

  readFile(path: WorkspacePath): Promise<WorkspaceFileContent | undefined> {
    const content = this.files.get(path);
    return Promise.resolve(content === undefined ? undefined : cloneContent(content));
  }

  writeFile(path: WorkspacePath, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  listFiles(): Promise<readonly WorkspacePath[]> {
    return Promise.resolve(
      [...this.files.keys()].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }

  exists(path: WorkspacePath): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  execute(command: string, options: ExecuteCommandOptions): Promise<WorkspaceCommandResult> {
    return Promise.resolve(this.executeCommand(command, options));
  }
}
