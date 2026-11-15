import type { BackendHandle } from "@cloudflare/computer";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { withWorkspaceSyncIgnore } from "../../src/workspace/backend-sync-ignore.js";
import { WORKSPACE_SYNC_IGNORES } from "../../src/workspace-layout.js";

type SyncRPC = BackendHandle["rpc"]["sync"];

type Received = Readonly<{ ignore?: string[] }>;

function unused(): never {
  throw new Error("this fake answers only fetches");
}

const CURSOR = { rev: 1, path: null };

function recordingSync(received: Received[], withPacks: boolean): SyncRPC {
  const sync: SyncRPC = {
    push: unused,
    fetchChanges: (input) => {
      received.push(input);

      return Promise.resolve({
        currentCursor: CURSOR,
        appliedPushCursor: CURSOR,
        stream: new ReadableStream(),
      });
    },
    watermarks: unused,
    readEntry: unused,
    hasObjects: unused,
    fetchObjects: unused,
    pushObjects: unused,
  };

  if (!withPacks) return sync;

  return {
    ...sync,
    fetchChangePack: (input) => {
      received.push(input);

      return Promise.resolve({
        cursor: CURSOR,
        drained: true,
        entryCount: 0,
        appliedPushCursor: CURSOR,
        stream: new ReadableStream(),
      });
    },
    applyChangePack: unused,
  };
}

async function connectedSync(received: Received[], withPacks: boolean): Promise<SyncRPC> {
  const handle: BackendHandle = {
    rpc: {
      sync: recordingSync(received, withPacks),
      shell: { exec: unused, getExec: unused, killExec: unused, disposeExec: unused },
    },
    runtimeId: "runtime",
    sync: "remote",
    close: unused,
  };

  const backend = withWorkspaceSyncIgnore({
    id: "backend",
    type: "test",
    connect: () => Promise.resolve(handle),
  });

  return (await backend.connect(0)).rpc.sync;
}

const callerIgnore = gs.optional(
  gs.arrays(
    gs.oneOf(
      gs.sampledFrom([...WORKSPACE_SYNC_IGNORES, ".cache", "target"]),
      gs.text({ maxSize: 6 }),
    ),
    { maxSize: 5 },
  ),
);

const after = gs.optional(
  gs.record({
    rev: gs.integers({ minValue: 0, maxValue: 100 }),
    path: gs.sampledFrom([null, "/project"]),
  }),
);

test("every fetch from the backend skips the sync ignores and the caller's ignores, once each, and keeps the rest of the request", () =>
  hegel.testAsync(async (tc) => {
    const ignore = tc.draw(callerIgnore);
    const cursor = tc.draw(after);
    const usePack = tc.draw(gs.booleans());
    const received: Received[] = [];
    const sync = await connectedSync(received, usePack);

    const request = {
      ...(cursor !== null && { after: cursor }),
      ...(ignore !== null && { ignore }),
    };

    const pack = { maxEntries: 1, maxBytes: 1, generation: "g", ...request };

    if (usePack) await sync.fetchChangePack?.(pack);
    else await sync.fetchChanges(request);

    expect(received).toHaveLength(1);
    const sent = received[0]?.ignore ?? [];
    const callerFirst = [...new Set(ignore ?? [])];

    expect({ ...received[0], ignore: [] }, "the rest of the request is passed on").toEqual({
      ...(usePack ? pack : request),
      ignore: [],
    });
    expect(sent.slice(0, callerFirst.length), "the caller's ignores come first").toEqual(
      callerFirst,
    );
    expect(new Set(sent)).toEqual(new Set([...callerFirst, ...WORKSPACE_SYNC_IGNORES]));
    expect(sent, "no ignore is sent twice").toHaveLength(new Set(sent).size);
  }));

test("the pack transport is offered exactly when the backend has one", async () => {
  const withPacks = await connectedSync([], true);
  const withoutPacks = await connectedSync([], false);

  expect("fetchChangePack" in withPacks && "applyChangePack" in withPacks).toBe(true);
  expect("fetchChangePack" in withoutPacks || "applyChangePack" in withoutPacks).toBe(false);
});
