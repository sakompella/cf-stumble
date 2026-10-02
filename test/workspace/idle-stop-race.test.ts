import { afterEach, expect, test, vi } from "vitest";
import { afterIdleStop, WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import type { ExecBackend } from "../../src/workspace/project/exec-backend.js";
import { capturedEvents } from "../log-capture.js";

/** Work that arrives while an idle stop is closing or destroying must wait for it. */

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
    closeWorkspace: async () => {
      calls.push("close");

      if (phase === "close") await gate;
    },
    stopContainer: async () => {
      calls.push("destroy");

      if (phase === "destroy") await gate;
    },
  });

  return { idle, clock, calls, release };
}

test("the controller says an idle stop is in progress from its first step", async () => {
  capturedEvents();
  const { idle, clock, release } = gated("close");
  idle.begin()();
  clock.now = 11_000;

  expect(idle.stopping()).toBe(false);
  const alarm = idle.onAlarm();
  expect(idle.stopping()).toBe(true);

  release.open();
  await alarm;
  expect(idle.stopping()).toBe(false);
});

test.each(["close", "destroy"] as const)(
  "an exec that starts during the %s waits for the stop, then runs",
  async (phase) => {
    capturedEvents();
    const { idle, clock, calls, release } = gated(phase);
    idle.begin()();
    clock.now = 11_000;
    const alarm = idle.onAlarm();
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
        });
      },
    };

    const end = idle.begin();
    const exec = afterIdleStop(idle, backend).exec({ command: "x", cwd: "/", timeoutMs: 1 });
    await tick();

    expect(started, "the exec does not start while the stop is in progress").toEqual([]);

    release.open();
    await alarm;
    await exec;
    end();

    expect(started).toEqual(["exec"]);
    expect(calls).toEqual(phase === "close" ? ["close"] : ["close", "destroy"]);
  },
);
