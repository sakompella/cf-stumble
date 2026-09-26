import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { logEvent } from "../diagnostics.js";
import { WORKSPACE_SYNC_IGNORES } from "../workspace-layout.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

type FetchChangesInput = Parameters<SyncRPC["fetchChanges"]>[0];

export interface WorkspaceBackendLifecycle {
  connected?(runtimeId: string | undefined): void;
  closed?(): void;
  failed?(): void;
}

function withIgnoredFetchChanges(
  handle: BackendHandle,
  lifecycle?: WorkspaceBackendLifecycle,
): BackendHandle {
  lifecycle?.connected?.(handle.runtimeId);

  if (handle.closed !== undefined) {
    void handle.closed.then(
      () => lifecycle?.closed?.(),
      () => lifecycle?.closed?.(),
    );
  }

  const sync = handle.rpc.sync;

  const wrappedSync: SyncRPC = {
    push: (input) => sync.push(input),
    fetchChanges: (input: FetchChangesInput) =>
      sync.fetchChanges({
        ...input,
        ignore: [...new Set([...(input.ignore ?? []), ...WORKSPACE_SYNC_IGNORES])],
      }),
    watermarks: () => sync.watermarks(),
    readEntry: (path) => sync.readEntry(path),
    hasObjects: (hashes) => sync.hasObjects(hashes),
    fetchObjects: (hashes) => sync.fetchObjects(hashes),
    pushObjects: (objects) => sync.pushObjects(objects),
  };

  return {
    ...handle,
    rpc: { sync: wrappedSync, shell: handle.rpc.shell },
  };
}

/** Decorate one backend without changing its transport or any RPC except sync.fetchChanges. */
export function withWorkspaceSyncIgnore(
  backend: WorkspaceBackend,
  lifecycle?: WorkspaceBackendLifecycle,
): WorkspaceBackend {
  const connect: WorkspaceBackend["connect"] = (host) =>
    backend.connect(host).then(
      (handle) => withIgnoredFetchChanges(handle, lifecycle),
      (error) => {
        lifecycle?.failed?.();
        throw error;
      },
    );

  if (backend.callable === undefined) {
    return { id: backend.id, type: backend.type, connect };
  }

  return { id: backend.id, type: backend.type, callable: backend.callable, connect };
}

export interface WorkspaceContainerStatus {
  running: boolean;
  exit: {
    reason?: string;
    cause?: string;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
}

function containerReasonCode(reason: string | undefined): string {
  if (reason === undefined) return "not-reported";

  if (/unexpected exit code/iu.test(reason)) return "unexpected-exit-code";

  if (/normally/iu.test(reason)) return "normal-exit";

  if (/network|connection/iu.test(reason)) return "connection-lost";

  return "unknown";
}

function containerExitCode(reason: string | undefined): number | null {
  const match = /exit code[=: ]+(\d+)/iu.exec(reason ?? "");

  return match === null ? null : Number(match[1]);
}

/** Record the lifecycle result after a backend transport closes. */
export async function recordWorkspaceContainerClosed(
  container: Readonly<{ status(): Promise<WorkspaceContainerStatus> }>,
): Promise<void> {
  try {
    const status = await container.status();
    const reason = status.exit?.reason ?? status.exit?.cause;
    const reasonCode = containerReasonCode(reason);
    const exitCode = status.exit?.exitCode ?? containerExitCode(reason);
    const signal = status.exit?.signal ?? null;
    logEvent("warn", "workspace.container.stopped", {
      outcome: "stopped",
      reasonCode,
      exitCode,
      signal,
      running: status.running,
    });

    if (status.exit !== null) {
      logEvent("warn", "workspace.container.exited", {
        outcome: "exited",
        reasonCode,
        exitCode,
        signal,
        expected: false,
      });
    }
  } catch {
    logEvent("warn", "workspace.container.stopped", {
      outcome: "stopped",
      reasonCode: "status-unavailable",
      exitCode: null,
      signal: null,
      running: false,
    });
  }
}
