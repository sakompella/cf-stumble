import type { BackendHandle } from "@cloudflare/computer";
import { expect, test } from "vitest";
import {
  withWorkspaceSyncIgnore,
  type HostedBackend,
} from "../../src/workspace/backend-sync-ignore.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

type FetchChangesInput = Parameters<SyncRPC["fetchChanges"]>[0];

function unused(name: string): never {
  throw new Error(name);
}

function syncFor(fetchChanges: SyncRPC["fetchChanges"]): SyncRPC {
  return {
    push: () => unused("sync.push"),
    fetchChanges,
    watermarks: () => unused("sync.watermarks"),
    readEntry: () => unused("sync.readEntry"),
    hasObjects: () => unused("sync.hasObjects"),
    fetchObjects: () => unused("sync.fetchObjects"),
    pushObjects: () => unused("sync.pushObjects"),
  };
}

function shellFor(): BackendHandle["rpc"]["shell"] {
  return {
    exec: () => unused("shell.exec"),
    getExec: () => unused("shell.getExec"),
    killExec: () => unused("shell.killExec"),
    disposeExec: () => unused("shell.disposeExec"),
  };
}

function backendWith(fetchChanges: SyncRPC["fetchChanges"]) {
  const sync = syncFor(fetchChanges);
  const shell = shellFor();

  const handle: BackendHandle = {
    rpc: { sync, shell },
    runtimeId: "runtime",
    sync: "remote",
    close: () => unused("close"),
  };

  const backend: HostedBackend<number> = {
    id: "backend",
    type: "test",
    callable: true,
    connect: () => Promise.resolve(handle),
  };

  return { backend };
}

function connect(backend: HostedBackend<number>): Promise<BackendHandle> {
  return backend.connect(0);
}

test("adds node_modules to a fetchChanges call with no caller ignore", async () => {
  const inputs: FetchChangesInput[] = [];

  const { backend } = backendWith((input) => {
    inputs.push(input);

    return Promise.resolve({
      currentCursor: { rev: 1, path: null },
      appliedPushCursor: { rev: 1, path: null },
      stream: new ReadableStream(),
    });
  });

  await (await connect(withWorkspaceSyncIgnore(backend))).rpc.sync.fetchChanges({});

  expect(inputs).toEqual([{ ignore: ["node_modules"] }]);
});

test("preserves caller ignores while adding node_modules", async () => {
  const inputs: FetchChangesInput[] = [];

  const { backend } = backendWith((input) => {
    inputs.push(input);

    return Promise.resolve({
      currentCursor: { rev: 1, path: null },
      appliedPushCursor: { rev: 1, path: null },
      stream: new ReadableStream(),
    });
  });

  await (
    await connect(withWorkspaceSyncIgnore(backend))
  ).rpc.sync.fetchChanges({
    after: { rev: 3, path: "/project" },
    ignore: [".cache"],
  });

  expect(inputs).toEqual([
    { after: { rev: 3, path: "/project" }, ignore: [".cache", "node_modules"] },
  ]);
});
