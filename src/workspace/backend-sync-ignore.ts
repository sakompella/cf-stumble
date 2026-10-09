import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
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
