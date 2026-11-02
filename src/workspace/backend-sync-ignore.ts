import type { BackendHandle } from "@cloudflare/computer";
import { WORKSPACE_SYNC_IGNORES } from "../workspace-layout.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

export type HostedBackend<Host> = Readonly<{
  id: string;
  type: string;
  callable?: boolean;
  description?: string;
  connect(host: Host): Promise<BackendHandle>;
}>;

function withSyncIgnores<Input extends { ignore?: string[] }>(input: Input): Input {
  return { ...input, ignore: [...new Set([...(input.ignore ?? []), ...WORKSPACE_SYNC_IGNORES])] };
}

type PackSyncRPC = SyncRPC & Required<Pick<SyncRPC, "fetchChangePack" | "applyChangePack">>;

function hasPackTransport(sync: SyncRPC): sync is PackSyncRPC {
  return sync.fetchChangePack !== undefined && sync.applyChangePack !== undefined;
}

function packTransport(sync: SyncRPC): Pick<SyncRPC, "fetchChangePack" | "applyChangePack"> {
  if (!hasPackTransport(sync)) return {};

  return {
    fetchChangePack: (input) => sync.fetchChangePack(withSyncIgnores(input)),
    applyChangePack: (input) => sync.applyChangePack(input),
  };
}

function withIgnoredFetchChanges(handle: BackendHandle): BackendHandle {
  const sync = handle.rpc.sync;

  const wrappedSync: SyncRPC = {
    push: (input) => sync.push(input),
    fetchChanges: (input) => sync.fetchChanges(withSyncIgnores(input)),
    watermarks: (input) => sync.watermarks(input),
    readEntry: (path) => sync.readEntry(path),
    hasObjects: (hashes) => sync.hasObjects(hashes),
    fetchObjects: (hashes) => sync.fetchObjects(hashes),
    pushObjects: (objects) => sync.pushObjects(objects),
    ...packTransport(sync),
  };

  return {
    ...handle,
    rpc: { sync: wrappedSync, shell: handle.rpc.shell },
  };
}

export function withWorkspaceSyncIgnore<Host>(
  backend: HostedBackend<Host>,
  connected?: (runtimeId: string | undefined) => void,
): HostedBackend<Host> {
  const connect: HostedBackend<Host>["connect"] = (host) =>
    backend.connect(host).then((handle) => {
      connected?.(handle.runtimeId);

      return withIgnoredFetchChanges(handle);
    });

  return {
    id: backend.id,
    type: backend.type,
    ...(backend.callable !== undefined && { callable: backend.callable }),
    ...(backend.description !== undefined && { description: backend.description }),
    connect,
  };
}
