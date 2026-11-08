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
    signal?: AbortSignal | undefined;
    run: Effect.Effect<A, E>;
    aborted: E;
  }>,
): Effect.Effect<A, E> {
  const { workspaceName, projectId } = input;

  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvision(workspaceName, projectId);

      if (active !== undefined) {
        const wait = yield* Effect.promise(() => settleActiveProvision(active, input.signal));

        if (wait === "aborted") return yield* Effect.fail(input.aborted);
        continue;
      }

      if (input.signal !== undefined && input.signal.aborted) {
        return yield* Effect.fail(input.aborted);
      }

      const settled = { settle: (): void => {} };

      const tracked = new Promise<void>((resolve) => {
        settled.settle = resolve;
      });

      const provisions = activeProvisions.get(workspaceName) ?? new Map<ProjectId, Promise<void>>();
      provisions.set(projectId, tracked);
      activeProvisions.set(workspaceName, provisions);

      return yield* Effect.uninterruptible(input.run).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            removeActiveProvision(workspaceName, projectId, tracked);
            settled.settle();
          }),
        ),
      );
    }
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

type ProvisionWait = "settled" | "aborted";

function settleActiveProvision(
  active: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<ProvisionWait> {
  if (signal !== undefined && signal.aborted) return Promise.resolve("aborted");

  return new Promise((resolve) => {
    const onAbort = () => {
      resolve("aborted");
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    void active.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("settled");
    });
  });
}

export function waitForWorkspaceProvision(
  workspaceName: string,
  projectId: ProjectId,
  signal?: AbortSignal,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const active = activeProvision(workspaceName, projectId);

    if (active === undefined) return signal?.aborted !== true;

    return (yield* Effect.promise(() => settleActiveProvision(active, signal))) === "settled";
  });
}
