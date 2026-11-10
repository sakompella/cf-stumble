import * as Effect from "effect/Effect";
import { logEvent } from "../../diagnostics.js";
import { type ProjectId } from "../../project-catalog.js";
import { projectDirectory } from "../../workspace-layout.js";
import { type WorkspaceEffects, type WorkspaceFault } from "../operations.js";

export function removedDirectories(projectId: ProjectId): readonly [string, string] {
  const root = projectDirectory(projectId);

  return [root, `${root}.provisioning`];
}

function remainingDirectories(
  operations: WorkspaceEffects,
  projectId: ProjectId,
): Effect.Effect<readonly string[], WorkspaceFault> {
  return Effect.gen(function* () {
    const remaining: string[] = [];

    for (const directory of removedDirectories(projectId)) {
      if ((yield* operations.lstat(directory)) !== undefined) remaining.push(directory);
    }

    return remaining;
  });
}

export function removedFromStore(
  operations: WorkspaceEffects,
  projectId: ProjectId,
): Effect.Effect<boolean, WorkspaceFault> {
  return Effect.gen(function* () {
    const unsynced = yield* remainingDirectories(operations, projectId);

    if (unsynced.length === 0) return true;

    logEvent("warn", "workspace.project-removal.store-kept-directories", {
      directories: unsynced.join(" "),
    });

    for (const directory of unsynced) yield* operations.removeTree(directory);

    return (yield* remainingDirectories(operations, projectId)).length === 0;
  });
}
