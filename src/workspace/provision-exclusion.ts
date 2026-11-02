import * as Effect from "effect/Effect";

const activeProvisions = new Map<string, Promise<void>>();

export function clearWorkspaceProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

export function provisionInWorkspace<A, E>(
  input: Readonly<{
    workspaceName: string;
    signal?: AbortSignal | undefined;
    run: Effect.Effect<A, E>;
    aborted: E;
  }>,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvisions.get(input.workspaceName);

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

      activeProvisions.set(input.workspaceName, tracked);

      return yield* Effect.uninterruptible(input.run).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            removeActiveProvision(input.workspaceName, tracked);
            settled.settle();
          }),
        ),
      );
    }
  });
}

function removeActiveProvision(workspaceName: string, active: Promise<void>): void {
  if (activeProvisions.get(workspaceName) === active) activeProvisions.delete(workspaceName);
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
  signal?: AbortSignal,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const active = activeProvisions.get(workspaceName);

    if (active === undefined) return signal?.aborted !== true;

    return (yield* Effect.promise(() => settleActiveProvision(active, signal))) === "settled";
  });
}
