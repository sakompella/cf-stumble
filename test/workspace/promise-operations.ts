import type { Project } from "../../src/project-catalog.js";
import {
  attemptWorkspace,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspacePathKind,
} from "../../src/workspace/operations.js";

export {
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspacePathKind,
} from "../../src/workspace/operations.js";

export type PromiseOperations = Readonly<{
  cloneProject?(project: Project): Promise<void>;
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

type Mutable = { -readonly [K in keyof WorkspaceEffects]: WorkspaceEffects[K] };

export function workspaceEffects(operations: PromiseOperations): WorkspaceEffects {
  const { cloneProject } = operations;

  const effects: Mutable = {
    lstat: (path) => attemptWorkspace(() => operations.lstat(path)),
    readFile: (path) => attemptWorkspace(() => operations.readFile(path)),
    writeFile: (path, content) => attemptWorkspace(() => operations.writeFile(path, content)),
    runCommand: (source, cwd, timeoutMs, stdin) =>
      attemptWorkspace(() => operations.runCommand(source, cwd, timeoutMs, stdin)),
  };

  if (cloneProject !== undefined) {
    effects.cloneProject = (project: Project) =>
      attemptWorkspace(() => cloneProject.call(operations, project));
  }

  return effects;
}
