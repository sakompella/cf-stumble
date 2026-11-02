import type { BackendHandle } from "@cloudflare/computer";
import { expect, test } from "vitest";
import {
  withWorkspaceSyncIgnore,
  type HostedBackend,
} from "../../src/workspace/backend-sync-ignore.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

type FetchChangesInput = Parameters<SyncRPC["fetchChanges"]>[0];

function delegated(calls: string[], name: string): never {
  calls.push(name);

  throw new Error(name);
}

function syncFor(calls: string[], fetchChanges: SyncRPC["fetchChanges"]): SyncRPC {
  return {
    push: () => delegated(calls, "sync.push"),
    fetchChanges,
    watermarks: () => delegated(calls, "sync.watermarks"),
    readEntry: () => delegated(calls, "sync.readEntry"),
    hasObjects: () => delegated(calls, "sync.hasObjects"),
    fetchObjects: () => delegated(calls, "sync.fetchObjects"),
    pushObjects: () => delegated(calls, "sync.pushObjects"),
  };
}

function shellFor(calls: string[]): BackendHandle["rpc"]["shell"] {
  return {
    exec: () => delegated(calls, "shell.exec"),
    getExec: () => delegated(calls, "shell.getExec"),
    killExec: () => delegated(calls, "shell.killExec"),
    disposeExec: () => delegated(calls, "shell.disposeExec"),
  };
}

function backendWith(fetchChanges: SyncRPC["fetchChanges"]) {
  const calls: string[] = [];
  const sync = syncFor(calls, fetchChanges);
  const shell = shellFor(calls);

  const handle: BackendHandle = {
    rpc: { sync, shell },
    runtimeId: "runtime",
    sync: "remote",
    close: () => delegated(calls, "close"),
  };

  const backend: HostedBackend<number> = {
    id: "backend",
    type: "test",
    callable: true,
    connect: () => {
      calls.push("connect");

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

test("delegates every backend and RPC operation other than fetchChanges", async () => {
  const { backend, calls, handle } = backendWith(() =>
    Promise.resolve({
      currentCursor: { rev: 1, path: null },
      appliedPushCursor: { rev: 1, path: null },
      stream: new ReadableStream(),
    }),
  );

  const wrappedHandle = await connect(withWorkspaceSyncIgnore(backend));

  expect(() =>
    wrappedHandle.rpc.sync.push({ senderRev: 0, changes: new ReadableStream() }),
  ).toThrow();
  expect(() => wrappedHandle.rpc.sync.watermarks()).toThrow();
  expect(() => wrappedHandle.rpc.sync.readEntry("/")).toThrow();
  expect(() => wrappedHandle.rpc.sync.hasObjects([])).toThrow();
  expect(() => wrappedHandle.rpc.sync.fetchObjects([])).toThrow();
  expect(() => wrappedHandle.rpc.sync.pushObjects(new ReadableStream())).toThrow();
  expect(() => wrappedHandle.rpc.shell.exec({ source: "true" })).toThrow();
  expect(() => wrappedHandle.rpc.shell.getExec({ id: "exec" })).toThrow();
  expect(() => wrappedHandle.rpc.shell.killExec({ id: "exec" })).toThrow();
  expect(() => wrappedHandle.rpc.shell.disposeExec({ id: "exec" })).toThrow();
  expect(() => wrappedHandle.close()).toThrow();

  expect(wrappedHandle.runtimeId).toBe(handle.runtimeId);
  expect(wrappedHandle.sync).toBe(handle.sync);
  expect(wrappedHandle.rpc.shell).toBe(handle.rpc.shell);
  expect(calls).toEqual([
    "connect",
    "sync.push",
    "sync.watermarks",
    "sync.readEntry",
    "sync.hasObjects",
    "sync.fetchObjects",
    "sync.pushObjects",
    "shell.exec",
    "shell.getExec",
    "shell.killExec",
    "shell.disposeExec",
    "close",
  ]);
});

test("forwards the settle flag to watermarks", async () => {
  const inputs: Parameters<SyncRPC["watermarks"]>[0][] = [];

  const { backend, handle } = backendWith(() => Promise.reject(new Error("unused")));

  handle.rpc.sync.watermarks = (input) => {
    inputs.push(input);

    return Promise.resolve({ currentRev: 1, pushRev: 1, fetchCursor: { rev: 1, path: null } });
  };

  await (await connect(withWorkspaceSyncIgnore(backend))).rpc.sync.watermarks({ settle: true });

  expect(inputs).toEqual([{ settle: true }]);
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

  handle.rpc.sync.applyChangePack = () => delegated([], "sync.applyChangePack");

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
