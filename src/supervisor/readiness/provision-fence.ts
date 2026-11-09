import * as Effect from "effect/Effect";
import { KeyedLock } from "../../keyed-lock.js";
import type { ProjectId } from "../../project-catalog.js";

const fences = new Map<string, KeyedLock<ProjectId>>();

function fence(workspaceName: string): KeyedLock<ProjectId> {
  const existing = fences.get(workspaceName);

  if (existing !== undefined) return existing;

  const created = new KeyedLock<ProjectId>();

  fences.set(workspaceName, created);

  return created;
}

export function clearWorkspaceProvision(workspaceName: string): void {
  fences.delete(workspaceName);
}

export function provisionInWorkspace<A, E>(
  input: Readonly<{
    workspaceName: string;
    projectId: ProjectId;
    run: Effect.Effect<A, E>;
  }>,
): Effect.Effect<A, E> {
  return Effect.suspend(() => fence(input.workspaceName).withLock(input.projectId, input.run));
}

export function waitForWorkspaceProvision(
  workspaceName: string,
  projectId: ProjectId,
): Effect.Effect<void> {
  return Effect.suspend(() => fence(workspaceName).withLock(projectId, Effect.void));
}
