import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { ContainerStopFailed } from "../../src/workspace/container-lifecycle.js";
import { afterIdleStop, WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import type { ExecBackend } from "../../src/workspace/project/exec-backend.js";
import { eventually, tick } from "../eventually.js";

const LIMIT = 10_000;

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
    const { idle, clock, calls, release } = gated(phase);
    idle.begin()();
    clock.now = 11_000;
    const alarm = idle.onAlarm();
    let stopFinished = false;

    const stopped = idle.settled().then(() => {
      stopFinished = true;
    });

    await eventually(() => {
      expect(calls.at(-1)).toBe(phase);
    });
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
    await stopped;

    expect(started).toEqual(["exec"]);
    expect(calls).toEqual(phase === "close" ? ["pull", "close"] : ["pull", "close", "destroy"]);
  },
);

test("a backend change during an idle stop that work keeps alive still stops the container", async () => {
  const { idle, clock, calls, release } = gated("close");
  idle.begin()();
  clock.now = 11_000;
  const alarm = idle.onAlarm();
  await eventually(() => {
    expect(calls).toEqual(["pull", "close"]);
  });
  const end = idle.begin();
  const backendChange = idle.stopForBackendChange();
  release.open();

  await alarm;
  await backendChange;
  end();

  expect(calls).toEqual(["pull", "close", "destroy"]);
});

test("a failed stop for a backend change rejects, and work waiting on the stop still runs", async () => {
  const idle = new WorkspaceIdleController({
    nowMs: () => 1_000,
    idleLimitMs: LIMIT,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => true,
    pullContainer: () => Promise.resolve(),
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () =>
      Effect.fail(new ContainerStopFailed({ cause: new Error("provider stop failed") })),
  });

  const backendChange = idle.stopForBackendChange();
  const waiting = idle.settled();

  await expect(backendChange).rejects.toThrow("provider stop failed");
  await expect(waiting).resolves.toBeUndefined();
});
