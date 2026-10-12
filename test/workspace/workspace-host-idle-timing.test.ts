/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Workspace } from "@cloudflare/computer";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { PROJECT_TURN_LEASE_MS } from "../../src/turn-budget.js";
import { WORKSPACE_IDLE_STOP_MS } from "../../src/workspace/idle-stop.js";
import { capturedEvents, named } from "../log-capture.js";

/**
 * The idle stop's timing and its race with new work, as the Host wires them. The quiet period
 * starts at the later of the last settled work and the end of a turn lease, and lasts exactly
 * `WORKSPACE_IDLE_STOP_MS`. Work that arrives while the stop closes the Workspace keeps the
 * container; work that arrives while it destroys the container waits for the destroy.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = 1_800_000_000_000;

class FakeContainer {
  running = true;
  readonly destroyed: string[] = [];
  destroyGate: Promise<void> | undefined;

  start(): void {
    throw new Error("the fake container does not launch");
  }

  monitor(): Promise<void> {
    return new Promise<void>(() => {});
  }

  destroy(reason: string): Promise<void> {
    this.destroyed.push(reason);

    if (reason === "idle") this.running = false;

    return this.destroyGate ?? Promise.resolve();
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

function gate() {
  const opened = { open: (): void => {} };

  const wait = new Promise<void>((resolve) => {
    opened.open = resolve;
  });

  return {
    wait,
    open: () => {
      opened.open();
    },
  };
}

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

test("settled work arms the alarm exactly one limit after it ends", async () => {
  const alarm = await withHost("idle-timing-rpc", async (host, state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await host.build({ kind: "not-a-build" });

    return state.storage.getAlarm();
  });

  expect(alarm).toBe(NOW + WORKSPACE_IDLE_STOP_MS);
});

test("a turn lease arms the alarm exactly one limit after the lease ends", async () => {
  const alarms = await withHost("idle-timing-lease", async (host, state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    host.project({ remainingMs: 60_000 });
    const budgeted = await state.storage.getAlarm();

    return { budgeted };
  });

  expect(alarms.budgeted).toBe(NOW + 60_000 + WORKSPACE_IDLE_STOP_MS);

  const unbudgeted = await withHost("idle-timing-default-lease", (host, state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    host.project();

    return state.storage.getAlarm();
  });

  expect(unbudgeted, "with no budget the lease is the default turn length").toBe(
    NOW + PROJECT_TURN_LEASE_MS + WORKSPACE_IDLE_STOP_MS,
  );
});

test("an alarm one millisecond before lease end plus the limit re-arms for that moment", async () => {
  const seen = await withHost("idle-timing-early", async (host, state, container) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    host.project({ remainingMs: 60_000 });
    vi.spyOn(Date, "now").mockReturnValue(NOW + 60_000 + WORKSPACE_IDLE_STOP_MS - 1);
    await host.alarm();

    return { alarm: await state.storage.getAlarm(), destroyed: container.destroyed };
  });

  expect(seen.destroyed).toEqual([]);
  expect(seen.alarm).toBe(NOW + 60_000 + WORKSPACE_IDLE_STOP_MS);
});

test("an RPC that begins during the idle close keeps the container and runs after the close", async () => {
  const events = capturedEvents();
  const closing = gate();

  const seen = await withHost("idle-timing-close-race", async (host, state, container) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await host.build({ kind: "not-a-build" });
    vi.spyOn(Workspace.prototype, "close").mockReturnValue(closing.wait);
    vi.spyOn(Date, "now").mockReturnValue(NOW + WORKSPACE_IDLE_STOP_MS);
    const alarm = host.alarm();
    await tick();

    let answered = false;

    const rpc = host.build({ kind: "not-a-build" }).then((result) => {
      answered = true;

      return result;
    });

    await tick();
    const answeredDuringClose = answered;
    closing.open();
    await alarm;
    await rpc;

    return {
      answeredDuringClose,
      destroyed: container.destroyed,
      alarm: await state.storage.getAlarm(),
    };
  });

  expect(seen.answeredDuringClose, "the RPC waits for the close to finish").toBe(false);
  expect(seen.destroyed, "work that began during the close keeps the container").toEqual([]);
  expect(named(events(), "workspace.container.idle-stop")).toEqual([
    expect.objectContaining({ outcome: "skipped-busy" }),
  ]);
  expect(seen.alarm, "the check is repeated one limit after the RPC ended").toBe(
    NOW + 2 * WORKSPACE_IDLE_STOP_MS,
  );
});

test("an RPC that begins during the idle destroy waits for it, then runs", async () => {
  capturedEvents();
  const destroying = gate();

  const seen = await withHost("idle-timing-destroy-race", async (host, _state, container) => {
    container.destroyGate = destroying.wait;
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await host.build({ kind: "not-a-build" });
    vi.spyOn(Date, "now").mockReturnValue(NOW + WORKSPACE_IDLE_STOP_MS);
    const alarm = host.alarm();
    await tick();

    let answered = false;

    const rpc = host.build({ kind: "not-a-build" }).then((result) => {
      answered = true;

      return result;
    });

    await tick();
    const answeredDuringDestroy = answered;
    destroying.open();
    await alarm;

    return { answeredDuringDestroy, result: await rpc, destroyed: container.destroyed };
  });

  expect(seen.destroyed).toEqual(["idle"]);
  expect(seen.answeredDuringDestroy, "the RPC does not touch a half-stopped Workspace").toBe(false);
  expect(seen.result).toEqual({ ok: false, error: { code: "invalid-request" } });
});

test("an alarm whose re-arm fails rejects, so the platform retries it", async () => {
  capturedEvents();

  const rejected = await withHost("idle-timing-rearm", async (host, state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await host.build({ kind: "not-a-build" });
    vi.spyOn(state.storage, "setAlarm").mockRejectedValue(new Error("alarm write failed"));

    return host.alarm({ retryCount: 1 }).then(
      () => "resolved",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
  });

  expect(rejected).toBe("alarm write failed");
});
