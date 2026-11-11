import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { afterIdleStop, WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import type { ExecBackend } from "../../src/workspace/project/exec-backend.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const LIMIT = 10_000;

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function gated(phase: "close" | "destroy") {
  const clock = { now: 1_000 };
  const calls: string[] = [];
  const release = { open: (): void => {} };

  const gate = new Promise<void>((resolve) => {
    release.open = resolve;
  });

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.now,
    idleLimitMs: LIMIT,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => true,
    pullContainer: () => {
      calls.push("pull");

      return Promise.resolve();
    },
    closeWorkspace: async () => {
      calls.push("close");

      if (phase === "close") await gate;
    },
    stopContainer: () =>
      Effect.sync(() => {
        calls.push("destroy");
      }).pipe(Effect.andThen(phase === "destroy" ? Effect.promise(() => gate) : Effect.void)),
  });

  return { idle, clock, calls, release };
}

test.each(["close", "destroy"] as const)(
  "work that starts during the %s waits for the stop, then runs",
  async (phase) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { idle, clock, calls, release } = gated(phase);
    idle.begin()();
    clock.now = 11_000;
    const alarm = idle.onAlarm();
    let stopFinished = false;
    void idle.settled().then(() => {
      stopFinished = true;
    });
    await tick();
    const started: string[] = [];

    const backend: ExecBackend = {
      exec: () => {
        started.push("exec");

        return Promise.resolve({
          reader: {
            read: () => Promise.resolve({ done: true as const }),
            cancel: () => Promise.resolve(),
          },
          kill: () => Promise.resolve(),
          backend: "container",
        });
      },
    };

    const end = idle.begin();
    const exec = afterIdleStop(idle, backend).exec({ command: "x", cwd: "/", timeoutMs: 1 });
    await tick();

    expect(started, "the exec does not start while the stop is in progress").toEqual([]);
    expect(stopFinished, "the stop has not settled while it is in progress").toBe(false);

    release.open();
    await alarm;
    await exec;
    end();
    await tick();

    expect(stopFinished).toBe(true);

    expect(started).toEqual(["exec"]);
    expect(calls).toEqual(phase === "close" ? ["pull", "close"] : ["pull", "close", "destroy"]);
  },
);

test("a backend change during an idle stop that work keeps alive still stops the container", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { idle, clock, calls, release } = gated("close");
  idle.begin()();
  clock.now = 11_000;
  const alarm = idle.onAlarm();
  await tick();
  const end = idle.begin();
  const backendChange = idle.stopForBackendChange();
  release.open();

  await alarm;
  await backendChange;
  end();

  expect(calls).toEqual(["pull", "close", "destroy"]);
});

test("a failed stop for a backend change rejects, and work waiting on the stop still runs", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  const idle = new WorkspaceIdleController({
    nowMs: () => 1_000,
    idleLimitMs: LIMIT,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => true,
    pullContainer: () => Promise.resolve(),
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () => Effect.fail(new Error("provider stop failed")),
  });

  const backendChange = idle.stopForBackendChange();
  const waiting = idle.settled();

  await expect(backendChange).rejects.toThrow("provider stop failed");
  await expect(waiting).resolves.toBeUndefined();
});
