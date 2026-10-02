/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";
import { capturedEvents, named } from "../log-capture.js";

/**
 * The Host's own wiring of the idle stop: which calls count as work, what the alarm closes and
 * destroys. `WorkspaceHost` needs a platform container, so these tests build one on the storage of
 * a Durable Object the test pool can run, with a container that records what it is asked to do.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeContainer {
  running = true;
  readonly destroyed: unknown[] = [];

  monitor(): Promise<void> {
    return new Promise<void>(() => {});
  }

  destroy(reason: string): Promise<void> {
    this.destroyed.push(reason);

    // Computer's own restart destroys the container first; only an idle stop leaves it stopped.
    if (reason === "idle") this.running = false;

    return Promise.resolve();
  }
}

function withHost<T>(
  name: string,
  run: (host: WorkspaceHost, state: DurableObjectState, container: FakeContainer) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    const container = new FakeContainer();

    Object.defineProperty(state, "container", { value: container, configurable: true });

    return run(new WorkspaceHost(state, {}), state, container);
  });
}

test("a Host RPC arms the idle alarm one limit after it ends", async () => {
  const armed = await withHost("host-seam-rpc", async (host, state) => {
    const before = Date.now();
    await host.build({ kind: "not-a-build" });

    return { alarm: await state.storage.getAlarm(), before };
  });

  expect(armed.alarm).not.toBeNull();
  expect((armed.alarm ?? 0) - armed.before).toBeGreaterThanOrEqual(WORKSPACE_IDLE_STOP_MS);
});

test("each tracked RPC arms the idle alarm when it ends", async () => {
  const requests = {
    build: (host: WorkspaceHost) => host.build({ kind: "not-a-build" }),
    provision: (host: WorkspaceHost) => host.provision({ kind: "not-a-step" }),
    removeProject: (host: WorkspaceHost) => host.removeProject({ kind: "not-a-removal" }),
    credential: (host: WorkspaceHost) => host.credential({ kind: "not-a-credential" }),
  };

  for (const [rpc, call] of Object.entries(requests)) {
    const alarm = await withHost(`host-seam-${rpc}`, async (host, state) => {
      await call(host);

      return state.storage.getAlarm();
    });

    expect(alarm, `${rpc} arms the alarm`).not.toBeNull();
  }
});

test("a project capability leases the workspace until the end of its turn", async () => {
  const leaseMs = 60_000;

  const result = await withHost("host-seam-lease", async (host, state) => {
    const before = Date.now();
    host.project({ remainingMs: leaseMs });

    return { alarm: await state.storage.getAlarm(), before };
  });

  const armedAfter = (result.alarm ?? 0) - result.before;
  expect(armedAfter).toBeGreaterThanOrEqual(leaseMs + WORKSPACE_IDLE_STOP_MS);
  expect(armedAfter, "the lease is the turn's budget, not the longer default").toBeLessThan(
    leaseMs + WORKSPACE_IDLE_STOP_MS + 5_000,
  );
});

test("a past-due alarm closes the Workspace and destroys the container for being idle", async () => {
  const events = capturedEvents();

  const destroyed = await withHost("host-seam-stop", async (host, _state, container) => {
    await host.build({ kind: "not-a-build" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + WORKSPACE_IDLE_STOP_MS + 1);
    await host.alarm();

    return container.destroyed;
  });

  expect(destroyed).toEqual(["idle"]);
  expect(named(events(), "workspace.container.idle-stop")).toEqual([
    expect.objectContaining({ outcome: "stopped", runningBefore: true }),
  ]);
});

test("a call on the project capability counts as activity", async () => {
  const quietMs = 120_000;

  const destroyed = await withHost("host-seam-touch", async (host, _state, container) => {
    const start = Date.now();
    const project = host.project({ remainingMs: 1_000 });
    vi.spyOn(Date, "now").mockReturnValue(start + quietMs);
    await project.lstat("/");
    vi.spyOn(Date, "now").mockReturnValue(start + WORKSPACE_IDLE_STOP_MS + quietMs - 1);
    await host.alarm();

    return container.destroyed;
  });

  expect(destroyed, "the alarm finds the limit not yet passed since the call").toEqual([]);
});

test("a reset that lost the alarm arms a new one", async () => {
  const alarm = await withHost("host-seam-reset", async (host, state) => {
    await host.build({ kind: "not-a-build" });
    await state.storage.deleteAlarm();
    await host.reset().catch(() => {});

    return state.storage.getAlarm();
  });

  expect(alarm).not.toBeNull();
});
