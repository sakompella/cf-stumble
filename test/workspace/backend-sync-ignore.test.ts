import type { BackendHandle } from "@cloudflare/computer";
import { expect, test } from "vitest";
import {
  withWorkspaceSyncIgnore,
  type HostedBackend,
} from "../../src/workspace/backend-sync-ignore.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

type FetchChangesInput = Parameters<SyncRPC["fetchChanges"]>[0];

type Call = readonly [name: string, args: readonly unknown[]];

function delegated(calls: Call[], name: string, args: readonly unknown[]): never {
  calls.push([name, args]);

  throw new Error(name);
}

function syncFor(calls: Call[], fetchChanges: SyncRPC["fetchChanges"]): SyncRPC {
  return {
    push: (...args) => delegated(calls, "sync.push", args),
    fetchChanges,
    watermarks: (...args) => delegated(calls, "sync.watermarks", args),
    readEntry: (...args) => delegated(calls, "sync.readEntry", args),
    hasObjects: (...args) => delegated(calls, "sync.hasObjects", args),
    fetchObjects: (...args) => delegated(calls, "sync.fetchObjects", args),
    pushObjects: (...args) => delegated(calls, "sync.pushObjects", args),
  };
}

function shellFor(calls: Call[]): BackendHandle["rpc"]["shell"] {
  return {
    exec: (...args) => delegated(calls, "shell.exec", args),
    getExec: (...args) => delegated(calls, "shell.getExec", args),
    killExec: (...args) => delegated(calls, "shell.killExec", args),
    disposeExec: (...args) => delegated(calls, "shell.disposeExec", args),
  };
}

function backendWith(fetchChanges: SyncRPC["fetchChanges"]) {
  const calls: Call[] = [];
  const sync = syncFor(calls, fetchChanges);
  const shell = shellFor(calls);

  const handle: BackendHandle = {
    rpc: { sync, shell },
    runtimeId: "runtime",
    sync: "remote",
    close: () => delegated(calls, "close", []),
  };

  const backend: HostedBackend<number> = {
    id: "backend",
    type: "test",
    callable: true,
    connect: () => {
      return Promise.resolve(handle);
    },
  };

  return { backend, calls, handle };
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

test("adds node_modules to a change pack fetch and keeps the pack transport", async () => {
  const inputs: Parameters<NonNullable<SyncRPC["fetchChangePack"]>>[0][] = [];

  const { backend, handle } = backendWith(() => Promise.reject(new Error("unused")));

  handle.rpc.sync.fetchChangePack = (input) => {
    inputs.push(input);

    return Promise.resolve({
      cursor: { rev: 1, path: null },
      drained: true,
      entryCount: 0,
      appliedPushCursor: { rev: 1, path: null },
      stream: new ReadableStream(),
    });
  };

  handle.rpc.sync.applyChangePack = (...args) => delegated([], "sync.applyChangePack", args);

  const sync = (await connect(withWorkspaceSyncIgnore(backend))).rpc.sync;

  await sync.fetchChangePack?.({ maxEntries: 1, maxBytes: 1, generation: "g" });

  expect(inputs).toEqual([
    { maxEntries: 1, maxBytes: 1, generation: "g", ignore: ["node_modules"] },
  ]);
  expect("applyChangePack" in sync).toBe(true);
});

test("offers no pack transport when the backend has none", async () => {
  const { backend } = backendWith(() => Promise.reject(new Error("unused")));

  const sync = (await connect(withWorkspaceSyncIgnore(backend))).rpc.sync;

  expect("fetchChangePack" in sync).toBe(false);
  expect("applyChangePack" in sync).toBe(false);
});
