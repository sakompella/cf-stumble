import { Workspace, type WorkspaceBackend } from "@cloudflare/computer";
import { WORKSPACE_OUTPUT_OPTIONS } from "../../infra/worker-settings.js";
import {
  ComputerWorkspaceOperations,
  newHarnessPermit,
} from "../../src/workspace/computer-operations.js";
import { computerStorage } from "../../src/workspace/workspace-platform.js";
import { HARNESS_BUILD_OUTPUT_PATH, WORKSPACE_ROOT } from "../../src/workspace-layout.js";

type Connection = Awaited<ReturnType<WorkspaceBackend["connect"]>>;

type SyncRpc = Connection["rpc"]["sync"];

type ChangeEntry =
  Awaited<ReturnType<SyncRpc["fetchChanges"]>>["stream"] extends ReadableStream<infer E>
    ? E
    : never;

type ExecEvent =
  Awaited<ReturnType<Connection["rpc"]["shell"]["exec"]>>["events"] extends ReadableStream<infer E>
    ? E
    : never;

export const OUTPUT_LIMIT_BYTES = 64 * 1024;

export const oversizedModuleMap = JSON.stringify({
  entryModule: "main.js",
  modules: [
    { name: "main.js", source: "export default { fetch() {} };\n" },
    {
      name: "padded.js",
      source: Array.from(
        { length: Math.trunc(OUTPUT_LIMIT_BYTES / 64) },
        (_unused, index) => `export const line${index} = "${"x".repeat(56)}";\n`,
      ).join(""),
    },
  ],
});

function closed<T>(...chunks: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function echoingConnection(fileBytes: Uint8Array, published: readonly ChangeEntry[]): Connection {
  const execEvents: readonly ExecEvent[] = [
    { id: "exec", seq: 0, name: "stdout", value: new TextEncoder().encode(oversizedModuleMap) },
    { id: "exec", seq: 1, name: "exit", code: 0 },
  ];

  return {
    runtimeId: "fake-runtime",
    sync: "remote",
    close: async () => {},
    rpc: {
      shell: {
        exec: () => Promise.resolve({ id: "exec", events: closed(...execEvents) }),
        getExec: () => Promise.reject(new Error("unused")),
        killExec: async () => {},
        disposeExec: async () => {},
      },
      sync: publishingSync(published, fileBytes),
    },
  };
}

function publishingSync(published: readonly ChangeEntry[], fileBytes: Uint8Array): SyncRpc {
  return {
    push: ({ senderRev }: { senderRev: number }) =>
      Promise.resolve({ rev: senderRev, appliedPushCursor: { rev: senderRev, path: null } }),
    fetchChanges: () =>
      Promise.resolve({
        currentCursor: { rev: 1, path: null },
        appliedPushCursor: { rev: 1, path: null },
        stream: closed(...published),
      }),
    watermarks: () =>
      Promise.resolve({ currentRev: 1, pushRev: 1, fetchCursor: { rev: 0, path: null } }),
    readEntry: () => Promise.resolve(null),
    hasObjects: (hashes: readonly Uint8Array[]) => Promise.resolve([...hashes]),
    fetchObjects: (hashes: readonly Uint8Array[]) =>
      closed(...hashes.map((requested) => ({ hash: requested, bytes: fileBytes }))),
    pushObjects: async (objects: ReadableStream<unknown>) => {
      for await (const _ of objects);
    },
  };
}

async function publishedEntries(): Promise<readonly ChangeEntry[]> {
  const fileBytes = new TextEncoder().encode(oversizedModuleMap);

  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", fileBytes));

  return [
    { kind: "dir", rev: 1, path: WORKSPACE_ROOT, mode: 0o755, mtime: 1 },
    {
      kind: "dir",
      rev: 1,
      path: HARNESS_BUILD_OUTPUT_PATH.slice(0, HARNESS_BUILD_OUTPUT_PATH.lastIndexOf("/")),
      mode: 0o755,
      mtime: 1,
    },
    {
      kind: "file",
      rev: 1,
      path: HARNESS_BUILD_OUTPUT_PATH,
      mode: 0o644,
      mtime: 1,
      size: fileBytes.byteLength,
      chunks: [{ hash, size: fileBytes.byteLength }],
    },
  ];
}

export async function operationsOverPublishedModuleMap(
  state: DurableObjectState,
): Promise<ComputerWorkspaceOperations> {
  const fileBytes = new TextEncoder().encode(oversizedModuleMap);
  const published = await publishedEntries();

  const workspace = new Workspace({
    storage: computerStorage(state.storage),
    backends: [
      {
        id: "container-shell",
        type: "fake-container",
        connect: () => Promise.resolve(echoingConnection(fileBytes, published)),
      },
    ],
    output: WORKSPACE_OUTPUT_OPTIONS,
  });

  return new ComputerWorkspaceOperations(workspace, "not-required", newHarnessPermit());
}
