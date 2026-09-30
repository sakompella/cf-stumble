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

export function containerStatusIndicatesReplacement(status: WorkspaceContainerStatus): boolean {
  return !status.running || status.exit !== null;
}

type ContainerReasonCode =
  | "not-reported"
  | "unexpected-exit-code"
  | "normal-exit"
  | "connection-lost"
  | "unknown"
  | "status-unavailable";

function containerReasonCode(reason: string | undefined): ContainerReasonCode {
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

/** One status read: what it returned, or that it failed. */
export type ContainerStatusRead =
  | { readonly read: "ok"; readonly status: WorkspaceContainerStatus }
  | { readonly read: "failed" };

/** Why the backend stopped being usable: its transport closed, or a connect attempt failed. */
export type BackendCloseTrigger = "transport-closed" | "connect-failed";

/** Read the status once; a rejection becomes `{ read: "failed" }`. */
export async function readContainerStatus(
  container: Readonly<{ status(): Promise<WorkspaceContainerStatus> }>,
): Promise<ContainerStatusRead> {
  try {
    return { read: "ok", status: await container.status() };
  } catch {
    return { read: "failed" };
  }
}

/**
 * Record that a backend closed or failed to connect, with what one status read saw. This is not a
 * stopped container, so `running` is `null` when the read failed. It writes one event.
 */
export function recordWorkspaceBackendClosed(
  trigger: BackendCloseTrigger,
  result: ContainerStatusRead,
): void {
  if (result.read === "failed") {
    const reasonCode: ContainerReasonCode = "status-unavailable";
    logEvent("warn", "workspace.backend.closed", {
      trigger,
      running: null,
      reasonCode,
      exitCode: null,
      signal: null,
      statusReadOutcome: "failed",
    });

    return;
  }

  const { status } = result;
  const reason = status.exit?.reason ?? status.exit?.cause;
  logEvent("warn", "workspace.backend.closed", {
    trigger,
    running: status.running,
    reasonCode: containerReasonCode(reason),
    exitCode: status.exit?.exitCode ?? containerExitCode(reason),
    signal: status.exit?.signal ?? null,
    statusReadOutcome: "ok",
  });
}

/**
 * Read the container status once after a backend closed, and decide from that one read. A
 * replacement bumps the caller's generation, and the same read is what the log reports, so the two
 * cannot disagree. A failed read proves nothing, so it bumps nothing.
 */
export async function observeBackendClose(
  container: Readonly<{ status(): Promise<WorkspaceContainerStatus> }>,
  trigger: BackendCloseTrigger,
  onReplaced: () => void,
): Promise<void> {
  const result = await readContainerStatus(container);

  if (result.read === "ok" && containerStatusIndicatesReplacement(result.status)) onReplaced();

  recordWorkspaceBackendClosed(trigger, result);
}
