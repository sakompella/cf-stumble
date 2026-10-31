import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
} from "@cloudflare/computer/backends/container";
import * as Effect from "effect/Effect";
import { logEvent } from "../diagnostics.js";

export type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy" }> }>;

export const WORKSPACE_BUSY = { ok: false, problem: { code: "workspace-busy" } } as const;

type WorkspaceStorageReset = Readonly<{
  deleteAll(): Promise<void>;
}>;

type WorkspaceContainerReset = Readonly<{
  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo>;
}>;

const WORKSPACE_CONTAINER_RESET_SPEC = {
  env: { PORT: "8080", MOUNT_POINT: "/workspace" },
  enableInternet: true,
} as const satisfies ContainerLaunchSpec;

export function resetWorkspaceStorage(
  storage: WorkspaceStorageReset,
  container: WorkspaceContainerReset,
): Effect.Effect<WorkspaceResetResult> {
  return Effect.promise(async () => {
    await storage.deleteAll();
    const restarted = await container.restart(WORKSPACE_CONTAINER_RESET_SPEC);
    logEvent("info", "workspace.reset", { runtimeId: restarted.runtimeId });

    return { ok: true, reset: "workspace" } as const;
  });
}
