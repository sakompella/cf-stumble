import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ContainerLaunchSpec } from "@cloudflare/computer/backends/container";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  snapshotBeforeStop,
  SnapshotContainerAPI,
} from "../../src/workspace/container-snapshot.js";
import { resetWorkspaceStorage } from "../../src/workspace/workspace-reset.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

const SPEC: ContainerLaunchSpec = { env: {}, enableInternet: true, name: "app" };

class SnapshotFake {
  running = false;
  images = { app: "image-1" };
  storePaths = 100;
  readonly starts: ContainerStartupOptions[] = [];
  snapshots = 0;
  hangs = false;
  restoreFails = false;

  start(options: ContainerStartupOptions): void {
    if (options.containerSnapshot !== undefined && this.restoreFails)
      throw new Error("restore failed");

    this.starts.push(options);
    this.running = true;
  }

  monitor(): Promise<void> {
    return new Promise(() => {});
  }

  destroy(): Promise<void> {
    this.running = false;

    return Promise.resolve();
  }

  exec(): Promise<Pick<ExecProcess, "output">> {
    if (this.hangs) return new Promise(() => {});

    const bytes = new TextEncoder().encode(`${String(this.storePaths)}\n`);
    const stdout = new ArrayBuffer(bytes.length);
    new Uint8Array(stdout).set(bytes);

    return Promise.resolve({
      output: () => Promise.resolve({ exitCode: 0, stdout, stderr: new ArrayBuffer(0) }),
    });
  }

  snapshotContainer(): Promise<ContainerSnapshot> {
    this.snapshots += 1;

    return Promise.resolve({ id: `snapshot-${String(this.snapshots)}`, size: 1 });
  }
}

type Host = Readonly<{
  fake: SnapshotFake;
  state: DurableObjectState;
  launch(): Promise<ContainerStartupOptions | undefined>;
  idleStop(): Promise<void>;
}>;

function withSnapshotHost(name: string, run: (host: Host) => Promise<void>): Promise<void> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), async (_instance, state) => {
    const fake = new SnapshotFake();
    Object.defineProperty(state, "container", { value: fake, configurable: true });
    const api = new SnapshotContainerAPI(state);

    await run({
      fake,
      state,
      launch: async () => {
        await api.start(SPEC);

        return fake.starts.at(-1);
      },
      idleStop: async () => {
        await snapshotBeforeStop(fake, state.storage.kv);
        fake.running = false;
      },
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("an idle stop snapshots the container and the next launch restores it with /workspace wiped", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-round-trip", async ({ fake, launch, idleStop }) => {
    expect(await launch()).toMatchObject({ image: "image-1" });
    await idleStop();

    const restored = await launch();
    expect(restored).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
    expect(restored?.entrypoint?.at(-1)).toMatch(/^rm -rf \/workspace && exec /u);
    expect(restored).not.toHaveProperty("image");
    expect(fake.snapshots).toBe(1);
  });
});

test("an idle stop takes a new snapshot only when the Nix store grew", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-growth", async ({ fake, launch, idleStop }) => {
    await launch();
    await idleStop();
    await launch();
    await idleStop();
    expect(fake.snapshots, "nothing new in the store").toBe(1);

    await launch();
    fake.storePaths += 1;
    await idleStop();
    expect(fake.snapshots).toBe(2);
    expect(await launch()).toMatchObject({ containerSnapshot: { id: "snapshot-2" } });
  });
});

test("a new image launches fresh, and its container is snapshotted only after it runs that image", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-image", async ({ fake, launch, idleStop }) => {
    await launch();
    fake.images = { app: "image-2" };
    await idleStop();
    expect(fake.snapshots, "the running container has the old image").toBe(0);

    expect(await launch()).toMatchObject({ image: "image-2" });
    await idleStop();
    fake.images = { app: "image-3" };
    expect(await launch()).toMatchObject({ image: "image-3" });
    fake.images = { app: "image-2" };
    fake.running = false;
    expect(await launch(), "the image-2 snapshot was dropped").toMatchObject({ image: "image-2" });
  });
});

test("a snapshot that never settles is given up after its bound and saves nothing", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-bound", async ({ fake, launch, state }) => {
    await launch();
    vi.useFakeTimers();
    fake.hangs = true;
    const stopped = snapshotBeforeStop(fake, state.storage.kv);
    const failure = expect(stopped).rejects.toThrow("container snapshot timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;

    expect(state.storage.kv.get("workspace-container-snapshot")).toBeUndefined();
  });
});

test("a failed restore falls back to the plain image start in the same call", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  await withSnapshotHost("snapshot-restore-fallback", async ({ fake, launch, idleStop }) => {
    await launch();
    await idleStop();
    fake.restoreFails = true;

    const started = await launch();

    expect(started).toMatchObject({ image: "image-1" });
    expect(started).not.toHaveProperty("containerSnapshot");
    expect(errors).toHaveBeenCalledWith(
      "workspace.container: snapshot restore failed: restore failed",
    );

    fake.restoreFails = false;
    expect(await launch(), "the record was dropped").toMatchObject({ image: "image-1" });
  });
});

test("a snapshot unused for 29 days is not restored", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-age", async ({ launch, idleStop }) => {
    await launch();
    await idleStop();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 29 * DAY_MS);

    expect(await launch()).toMatchObject({ image: "image-1" });
  });
});

test("a workspace reset drops the snapshot", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  await withSnapshotHost("snapshot-reset", async ({ state, launch, idleStop }) => {
    await launch();
    await idleStop();
    await Effect.runPromise(resetWorkspaceStorage(state.storage, Effect.void));

    expect(await launch()).toMatchObject({ image: "image-1" });
  });
});
