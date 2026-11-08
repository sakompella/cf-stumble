import type {
  ExecSyncResult,
  Workspace,
  WorkspaceRuntimeExecOptions,
  WorkspaceRuntimeResult,
} from "@cloudflare/computer";
import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  attemptWorkspace,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceEffects,
  type WorkspaceFault,
  type WorkspacePathKind,
} from "./operations.js";
import { hasErrnoCode } from "./errno-code.js";
import { provisionHarness } from "./harness-provision.js";
import { cloneProjectInIsolate } from "./isolate-clone.js";
import { CONTAINER_BACKEND_ID } from "./project/index.js";
import type { Project } from "../project-catalog.js";

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
    throw new WorkspaceSyncIncomplete({
      message: `post-command sync ${result.sync.status} (exit ${String(result.exitCode)}, skipped ${String(result.sync.skipped.length)})`,
    });
  }

  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

export function newHarnessPermit(): Semaphore.Semaphore {
  return Semaphore.makeUnsafe(1);
}

export class ComputerWorkspaceOperations implements WorkspaceEffects {
  private readonly workspace: Workspace;
  private readonly sync: CommandSync;
  private readonly harnessPermit: Semaphore.Semaphore;

  constructor(workspace: Workspace, sync: CommandSync, harnessPermit: Semaphore.Semaphore) {
    this.workspace = workspace;
    this.sync = sync;
    this.harnessPermit = harnessPermit;
  }

  provisionHarness: WorkspaceEffects["provisionHarness"] = (configuration, commit) =>
    this.harnessPermit.withPermits(1)(provisionHarness(this.workspace, configuration, commit));

  cloneProject(project: Project): Effect.Effect<void, WorkspaceFault> {
    return cloneProjectInIsolate(this.workspace, project);
  }

  lstat(path: string): Effect.Effect<WorkspacePathKind | undefined, WorkspaceFault> {
    return attemptWorkspace(async (): Promise<WorkspacePathKind | undefined> => {
      try {
        const entry = await this.workspace.fs.lstat(path);

        if (entry.isSymbolicLink) return "symbolic-link";

        return entry.isDirectory ? "directory" : "file";
      } catch (cause) {
        if (isNotFound(cause)) return undefined;
        throw cause;
      }
    });
  }

  readFile(path: string): Effect.Effect<string, WorkspaceFault> {
    return attemptWorkspace(() => this.workspace.fs.readFile(path, "utf8"));
  }

  writeFile(path: string, content: string): Effect.Effect<void, WorkspaceFault> {
    return attemptWorkspace(() => this.workspace.fs.writeFile(path, content));
  }

  runCommand(
    source: string,
    cwd: string,
    timeoutMs: number,
    stdin?: string,
  ): Effect.Effect<CommandOutput, WorkspaceFault> {
    const options: WorkspaceRuntimeExecOptions<"utf8"> = {
      backend: CONTAINER_BACKEND_ID,
      cwd,
      encoding: "utf8",
      timeoutMs,
    };

    if (stdin !== undefined) options.stdin = stdin;

    return attemptWorkspace(async () => {
      const execution = await this.workspace.runtime.exec(source, options);

      return commandOutput(await execution.result(), this.sync);
    });
  }
}
