import * as Effect from "effect/Effect";
import type { ProjectId } from "../../project-catalog.js";

const activeProvisions = new Map<string, Map<ProjectId, Promise<void>>>();

export function clearWorkspaceProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

function activeProvision(workspaceName: string, projectId: ProjectId): Promise<void> | undefined {
  return activeProvisions.get(workspaceName)?.get(projectId);
}

export function provisionInWorkspace<A, E>(
  input: Readonly<{
    workspaceName: string;
    projectId: ProjectId;
    run: Effect.Effect<A, E>;
  }>,
): Effect.Effect<A, E> {
  const { workspaceName, projectId } = input;

  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvision(workspaceName, projectId);

      if (active === undefined) break;

      yield* Effect.promise(() => active);
    }

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const settled = { settle: (): void => {} };

        const tracked = new Promise<void>((resolve) => {
          settled.settle = resolve;
        });

        const provisions =
          activeProvisions.get(workspaceName) ?? new Map<ProjectId, Promise<void>>();

        provisions.set(projectId, tracked);
        activeProvisions.set(workspaceName, provisions);

        return { tracked, settled };
      }),
      () => input.run,
      ({ tracked, settled }) =>
        Effect.sync(() => {
          removeActiveProvision(workspaceName, projectId, tracked);
          settled.settle();
        }),
    );
  });
}

function removeActiveProvision(
  workspaceName: string,
  projectId: ProjectId,
  active: Promise<void>,
): void {
  const provisions = activeProvisions.get(workspaceName);

  if (provisions?.get(projectId) !== active) return;
  provisions.delete(projectId);

  if (provisions.size === 0) activeProvisions.delete(workspaceName);
}

export function waitForWorkspaceProvision(
  workspaceName: string,
  projectId: ProjectId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const active = activeProvision(workspaceName, projectId);

    return active === undefined ? Effect.void : Effect.promise(() => active);
  });
}
