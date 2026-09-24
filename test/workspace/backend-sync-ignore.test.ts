import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { expect, test } from "vitest";
import { withWorkspaceSyncIgnore } from "../../src/workspace/backend-sync-ignore.js";
import { workspaceBackendForHost } from "../../src/workspace/host.js";

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

  const backend: WorkspaceBackend = {
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

function connect(backend: WorkspaceBackend): Promise<BackendHandle> {
  // The fake backend does not use the host. Calling through its typed member keeps this test on
  // the backend seam without manufacturing an unrelated database and filesystem.
  // oxlint-disable-next-line anti-slop/no-reflect-apply, typescript/no-unsafe-return, typescript/unbound-method -- SAFETY: the fake backend ignores its host.
  return Reflect.apply(backend.connect, backend, []);
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

test("WorkspaceHost constructs its Workspace with the sync-ignore backend", async () => {
  const inputs: FetchChangesInput[] = [];

  const { backend } = backendWith((input) => {
    inputs.push(input);

    return Promise.resolve({
      currentCursor: { rev: 1, path: null },
      appliedPushCursor: { rev: 1, path: null },
      stream: new ReadableStream(),
    });
  });

  await (await connect(workspaceBackendForHost(backend))).rpc.sync.fetchChanges({});

  expect(inputs).toEqual([{ ignore: ["node_modules"] }]);
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
