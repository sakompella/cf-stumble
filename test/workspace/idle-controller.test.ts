import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const LIMIT = 10_000;

type Behavior = Readonly<{
  running?: boolean;
  pull?: "fails" | "hangs";
  closeFails?: boolean;
  destroyFails?: boolean;
  alarmFails?: boolean;
  duringClose?: (
    world: Readonly<{ idle: WorkspaceIdleController; state: { running: boolean } }>,
  ) => void;
}>;

function controller(options: Behavior = {}) {
  const clock = { now: 1_000 };
  const state = { running: options.running ?? true };
  const alarms: number[] = [];
  const calls: string[] = [];

  const world = {
    get idle() {
      return idle;
    },
    state,
  };

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.now,
    idleLimitMs: LIMIT,
    setAlarm: (atMs) => {
      alarms.push(atMs);

      return options.alarmFails === true
        ? Promise.reject(new Error("alarm write failed"))
        : Promise.resolve();
    },
    containerRunning: () => state.running,
    pullContainer: () => {
      calls.push("pull");

      if (options.pull === "fails") return Promise.reject(new Error("pull failed"));

      return options.pull === "hangs" ? new Promise<void>(() => {}) : Promise.resolve();
    },
    closeWorkspace: () => {
      calls.push("close");

      options.duringClose?.(world);

      return options.closeFails === true
        ? Promise.reject(new Error("close failed"))
        : Promise.resolve();
    },
    stopContainer: () =>
      Effect.suspend(() => {
        calls.push("destroy");
        state.running = false;

        return options.destroyFails === true
          ? Effect.die(new Error("destroy failed"))
          : Effect.void;
      }),
  });

  return { idle, clock, state, alarms, calls };
}

test("work that settles arms the alarm one limit after it ended", () => {
  const { idle, clock, alarms } = controller();
  const end = idle.begin();
  clock.now = 4_000;
  end();

  expect(alarms).toEqual([14_000]);
});

test("a burst of work writes the alarm once", () => {
  const { idle, clock, alarms } = controller();

  for (let step = 0; step < 5; step += 1) {
    clock.now += 100;
    idle.begin()();
    idle.touch();
  }

  expect(alarms).toHaveLength(1);
});

test("work in flight is counted until its own end, and ending twice counts once", () => {
  const { idle } = controller();
  const first = idle.begin();
  const second = idle.begin();

  first();
  first();
  expect(idle.snapshot().inFlight).toBe(1);

  second();
  expect(idle.snapshot().inFlight).toBe(0);
});

test("nothing is armed while no container runs", () => {
  const { idle, alarms } = controller({ running: false });

  idle.begin()();
  idle.touch();
  idle.lease(50_000);

  expect(alarms).toEqual([]);
});

test("an alarm that could not be written is tried again on the next activity", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const failing = controller({ alarmFails: true });
  failing.idle.touch();
  await flush();
  failing.idle.touch();

  expect(failing.alarms).toHaveLength(2);
});

test("forgetting the alarm lets the next activity arm a new one", () => {
  const { idle, alarms } = controller();
  idle.touch();
  idle.forgetAlarm();
  idle.touch();

  expect(alarms).toHaveLength(2);
});

test("an alarm that cannot re-arm itself rejects, so the platform runs it again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock } = controller({ alarmFails: true });
  clock.now = 6_000;

  await expect(idle.onAlarm()).rejects.toThrow("alarm write failed");
});

test("an alarm before the limit re-arms for the moment the limit passes", async () => {
  const { idle, clock, alarms, calls } = controller();
  idle.begin()();
  clock.now = 6_000;
  await idle.onAlarm();

  expect(alarms).toEqual([11_000, 11_000]);
  expect(calls).toEqual([]);
});

test("an alarm that finds the container stopped arms nothing and stops nothing", async () => {
  const { idle, clock, state, alarms, calls } = controller();
  idle.begin()();
  state.running = false;
  clock.now = 20_000;
  await idle.onAlarm();

  expect(alarms).toHaveLength(1);
  expect(calls).toEqual([]);
});

test.each([
  [
    "work that begins",
    (idle: WorkspaceIdleController) => {
      idle.begin();
    },
  ],
  [
    "a turn lease taken",
    (idle: WorkspaceIdleController) => {
      idle.lease(60_000);
    },
  ],
])("%s during the close keeps the container, and the check is repeated later", async (_, busy) => {
  const { idle, clock, alarms, calls } = controller({
    duringClose: (world) => {
      busy(world.idle);
    },
  });

  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["pull", "close"]);
  expect(alarms.at(-1)).toBe(21_000);
});

test("a failed close still destroys the container, and a stopped container is not checked again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock, alarms, calls } = controller({ closeFails: true });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["pull", "close", "destroy"]);
  expect(alarms).toHaveLength(1);
});

test("a failed destroy checks again one limit later", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock, alarms } = controller({ destroyFails: true });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(alarms.at(-1)).toBe(21_000);
});

test("a container that exits during the close is not destroyed", async () => {
  const { idle, clock, calls } = controller({
    duringClose: (world) => {
      world.state.running = false;
    },
  });

  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["pull", "close"]);
});

test("an idle stop pulls the container's changes before it closes and destroys", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { idle, clock, calls } = controller();
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["pull", "close", "destroy"]);
});

test("a stop for a backend change pulls before it closes and destroys", async () => {
  const { idle, calls } = controller();
  await idle.stopForBackendChange();

  expect(calls).toEqual(["pull", "close", "destroy"]);
});

test("a failed pull is logged and still closes and destroys the container", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock, calls } = controller({ pull: "fails" });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["pull", "close", "destroy"]);
  expect(errors).toHaveBeenCalledWith("workspace.idle-stop: final pull failed: pull failed");
});

test("a pull that never settles is given up after its bound, and the container is destroyed", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock, calls } = controller({ pull: "hangs" });
  idle.begin()();
  clock.now = 11_000;
  const alarm = idle.onAlarm();
  await vi.runAllTimersAsync();
  await alarm;

  expect(calls).toEqual(["pull", "close", "destroy"]);
  expect(errors).toHaveBeenCalledOnce();
});
