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
    expect(calls).toEqual(phase === "close" ? ["close"] : ["close", "destroy"]);
  },
);
