import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const LIMIT = 10_000;

type Behavior = Readonly<{
  running?: boolean;
  closeFails?: boolean;
  destroyFails?: boolean;
  alarmFails?: boolean;
  /** Runs while the close is pending, as a request arriving mid-stop would. */
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
    closeWorkspace: () => {
      calls.push("close");

      options.duringClose?.(world);

      return options.closeFails === true
        ? Promise.reject(new Error("close failed"))
        : Promise.resolve();
    },
    stopContainer: () => {
      calls.push("destroy");
      state.running = false;

      return options.destroyFails === true
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve();
    },
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
  idle.leaseUntil(50_000);

  expect(alarms).toEqual([]);
});

test("a lease moves the alarm to one limit after it ends, and an earlier lease does not shorten it", () => {
  const { idle, alarms } = controller();
  idle.leaseUntil(500_000);
  idle.leaseUntil(300_000);

  expect(alarms).toEqual([510_000]);
  expect(idle.snapshot().leaseEndsAtMs).toBe(500_000);
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

test("an alarm before the limit re-arms for the moment the limit passes", async () => {
  const { idle, clock, alarms, calls } = controller();
  idle.begin()();
  clock.now = 6_000;
  await idle.onAlarm();

  expect(alarms).toEqual([11_000, 11_000]);
  expect(calls).toEqual([]);
});

test("an alarm that cannot re-arm itself rejects, so the platform runs it again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock } = controller({ alarmFails: true });
  clock.now = 6_000;

  await expect(idle.onAlarm()).rejects.toThrow("alarm write failed");
});

test("an alarm while work is in flight checks again a full limit later and stops nothing", async () => {
  const { idle, clock, alarms, calls } = controller();
  idle.begin();
  idle.touch();
  clock.now = 20_000;
  await idle.onAlarm();

  expect(alarms.at(-1)).toBe(30_000);
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

test("an alarm at the limit closes the Workspace and destroys the container", async () => {
  const { idle, clock, alarms, calls } = controller();
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close", "destroy"]);
  expect(alarms, "a stopped container is not checked again").toHaveLength(1);
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
      idle.leaseUntil(60_000);
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

  expect(calls).toEqual(["close"]);
  expect(alarms.at(-1)).toBe(21_000);
});

test("a failed close is logged and the container is still destroyed", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { idle, clock, calls } = controller({ closeFails: true });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close", "destroy"]);
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

  expect(calls).toEqual(["close"]);
});

test("a second alarm during a stop does not start another", async () => {
  const { idle, clock, calls } = controller();
  idle.begin()();
  clock.now = 11_000;

  await Promise.all([idle.onAlarm(), idle.onAlarm()]);

  expect(calls).toEqual(["close", "destroy"]);
});
