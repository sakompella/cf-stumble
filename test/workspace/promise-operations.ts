import type { HarnessBuildConfiguration } from "../../src/harness-build.js";
import type { HarnessCommit } from "../../src/harness-commit.js";
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
  provisionHarness?(
    configuration: HarnessBuildConfiguration,
    commit: HarnessCommit,
  ): Promise<CommandOutput>;
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  readFile(path: string): Promise<string>;
  removeTree?(path: string): Promise<void>;
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
  const { cloneProject, provisionHarness } = operations;

  const effects: Mutable = {
    cloneProject: (project: Project) =>
      attemptWorkspace(() =>
        cloneProject === undefined
          ? Promise.reject(new Error("this fake clones no project"))
          : cloneProject.call(operations, project),
      ),
    lstat: (path) => attemptWorkspace(() => operations.lstat(path)),
    readFile: (path) => attemptWorkspace(() => operations.readFile(path)),
    removeTree: (path) =>
      attemptWorkspace(() =>
        operations.removeTree === undefined
          ? Promise.reject(new Error("this fake removes no tree"))
          : operations.removeTree(path),
      ),
    writeFile: (path, content) => attemptWorkspace(() => operations.writeFile(path, content)),
    runCommand: (source, cwd, timeoutMs, stdin) =>
      attemptWorkspace(() => operations.runCommand(source, cwd, timeoutMs, stdin)),
    provisionHarness: (configuration, commit) =>
      attemptWorkspace(() =>
        provisionHarness === undefined
          ? Promise.reject(new Error("this fake provisions no harness"))
          : provisionHarness.call(operations, configuration, commit),
      ),
  };

  return effects;
}
