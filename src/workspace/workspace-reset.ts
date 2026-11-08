import * as Effect from "effect/Effect";
import { logEvent } from "../diagnostics.js";

export type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy" }> }>;

export const WORKSPACE_BUSY = { ok: false, problem: { code: "workspace-busy" } } as const;

type WorkspaceStorageReset = Readonly<{
  deleteAll(): Promise<void>;
}>;

export function resetWorkspaceStorage(
  storage: WorkspaceStorageReset,
  stopContainer: () => Promise<void>,
): Effect.Effect<WorkspaceResetResult> {
  return Effect.promise(() => storage.deleteAll()).pipe(
    Effect.andThen(Effect.promise(() => stopContainer())),
    Effect.andThen(
      Effect.sync(() => {
        logEvent("info", "workspace.reset");

        return { ok: true, reset: "workspace" } as const;
      }),
    ),
  );
}
