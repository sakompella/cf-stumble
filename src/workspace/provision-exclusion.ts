import * as Effect from "effect/Effect";
import {
  WORKSPACE_RPC_TIMEOUT_MARGIN_MS,
  WORKSPACE_RPC_TIMEOUT_MS,
} from "../workspace-command-timeout.js";
import { HARNESS_PROVISION_STEP_NAMES, PROJECT_PLAN_STEP_NAMES } from "./provision-plan.js";

type ActiveProvision = Readonly<{
  operation: Promise<unknown>;
  startedAt: number;
}>;

const PROVISION_PLAN_STEP_COUNT = Math.max(
  PROJECT_PLAN_STEP_NAMES.length,
  HARNESS_PROVISION_STEP_NAMES.length,
);

export const PROVISION_STALE_AFTER_MS =
  PROVISION_PLAN_STEP_COUNT * WORKSPACE_RPC_TIMEOUT_MS + WORKSPACE_RPC_TIMEOUT_MARGIN_MS;

const activeProvisions = new Map<string, ActiveProvision>();

export function clearWorkspaceProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

function provisionIsStale(active: ActiveProvision, now: number): boolean {
  return now - active.startedAt > PROVISION_STALE_AFTER_MS;
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

      if (active !== undefined && !provisionIsStale(active, Date.now())) {
        const wait = yield* Effect.promise(() => settleActiveProvision(active, input.signal));

        if (wait === "aborted") return yield* Effect.fail(input.aborted);
        continue;
      }

      if (active !== undefined) clearStaleProvision(input.workspaceName);

      if (input.signal !== undefined && input.signal.aborted) {
        return yield* Effect.fail(input.aborted);
      }

      const settled = { settle: (): void => {} };

      const tracked: ActiveProvision = {
        operation: new Promise<void>((resolve) => {
          settled.settle = resolve;
        }),
        startedAt: Date.now(),
      };

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

function removeActiveProvision(workspaceName: string, active: ActiveProvision): void {
  if (activeProvisions.get(workspaceName) === active) activeProvisions.delete(workspaceName);
}

function clearStaleProvision(workspaceName: string): void {
  activeProvisions.delete(workspaceName);
}

type ProvisionWait = "settled" | "aborted" | "stale";

function settleActiveProvision(
  active: ActiveProvision,
  signal: AbortSignal | undefined,
): Promise<ProvisionWait> {
  if (signal !== undefined && signal.aborted) return Promise.resolve("aborted");

  const remaining = Math.max(0, PROVISION_STALE_AFTER_MS - (Date.now() - active.startedAt) + 1);

  return new Promise((resolve) => {
    let finished = false;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ProvisionWait) => {
      if (finished) return;

      finished = true;

      if (staleTimer !== undefined) clearTimeout(staleTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      finish("aborted");
    };

    staleTimer = setTimeout(() => {
      finish("stale");
    }, remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    active.operation.then(
      () => {
        finish("settled");
      },
      () => {
        finish("settled");
      },
    );
  });
}

export function waitForWorkspaceProvision(
  workspaceName: string,
  signal?: AbortSignal,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (;;) {
      const active = activeProvisions.get(workspaceName);

      if (active === undefined) return signal?.aborted !== true;

      if (provisionIsStale(active, Date.now())) {
        clearStaleProvision(workspaceName);

        continue;
      }

      const wait = yield* Effect.promise(() => settleActiveProvision(active, signal));

      if (wait === "aborted") return false;

      if (wait === "settled") return true;
    }
  });
}
