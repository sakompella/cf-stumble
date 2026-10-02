import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import { capturedEvents, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const LIMIT = 10_000;

type Behavior = Readonly<{
  running?: boolean;
  closeFails?: boolean;
  destroyFails?: boolean;
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

      return Promise.resolve();
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
  expect(idle.snapshot()).toEqual({ inFlight: 0, lastActiveAtMs: 4_000, leaseEndsAtMs: null });
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

test("a lease moves the first alarm to one limit after the lease ends", () => {
  const { idle, alarms } = controller();
  idle.leaseUntil(500_000);

  expect(alarms).toEqual([510_000]);
  expect(idle.snapshot().leaseEndsAtMs).toBe(500_000);
});

test("a later lease extends and an earlier one does not shorten", () => {
  const { idle } = controller();
  idle.leaseUntil(500_000);
  idle.leaseUntil(300_000);

  expect(idle.snapshot().leaseEndsAtMs).toBe(500_000);
});

test("an alarm before the limit re-arms for the moment the limit passes", async () => {
  const events = capturedEvents();
  const { idle, clock, alarms } = controller();
  idle.begin()();
  clock.now = 6_000;
  await idle.onAlarm();

  expect(alarms).toEqual([11_000, 11_000]);
  expect(named(events(), "workspace.idle-check")).toEqual([
    expect.objectContaining({
      inFlight: 0,
      idleForMs: 5_000,
      idleLimitMs: LIMIT,
      running: true,
      decision: "check-at",
    }),
  ]);
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
  const events = capturedEvents();
  const { idle, clock, state, alarms, calls } = controller();
  idle.begin()();
  state.running = false;
  clock.now = 20_000;
  await idle.onAlarm();

  expect(alarms).toHaveLength(1);
  expect(calls).toEqual([]);
  expect(named(events(), "workspace.idle-check").at(0)).toMatchObject({
    running: false,
    decision: "stop",
  });
});

test("an alarm at the limit closes the Workspace, destroys the container, and logs the stop", async () => {
  const events = capturedEvents();
  const { idle, clock, alarms, calls } = controller();
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close", "destroy"]);
  expect(alarms, "a stopped container is not checked again").toHaveLength(1);
  expect(named(events(), "workspace.container.stop-requested")).toEqual([
    expect.objectContaining({ reasonCode: "idle-stop" }),
  ]);
  expect(named(events(), "workspace.container.idle-stop")).toEqual([
    expect.objectContaining({
      level: "info",
      idleForMs: 10_000,
      idleLimitMs: LIMIT,
      runningBefore: true,
      outcome: "stopped",
      durationMs: 0,
    }),
  ]);
});

test("one millisecond before the limit nothing stops", async () => {
  const { idle, clock, calls } = controller();
  idle.begin()();
  clock.now = 10_999;
  await idle.onAlarm();

  expect(calls).toEqual([]);
});

test("no stop while a turn lease is open, then a stop one limit after it ends", async () => {
  const { idle, clock, calls } = controller();
  idle.leaseUntil(30_000);
  clock.now = 20_000;
  await idle.onAlarm();
  expect(calls).toEqual([]);

  clock.now = 40_000;
  await idle.onAlarm();
  expect(calls).toEqual(["close", "destroy"]);
});

test("work that begins during the close keeps the container, and the check is repeated later", async () => {
  const events = capturedEvents();

  const { idle, clock, alarms, calls } = controller({
    duringClose: (world) => {
      world.idle.begin();
    },
  });

  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close"]);
  expect(named(events(), "workspace.container.idle-stop").at(0)).toMatchObject({
    outcome: "skipped-busy",
  });
  expect(alarms.at(-1)).toBe(21_000);
});

test("a turn lease taken during the close keeps the container, and the check is repeated later", async () => {
  const events = capturedEvents();

  const { idle, clock, alarms, calls } = controller({
    duringClose: (world) => {
      world.idle.leaseUntil(60_000);
    },
  });

  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close"]);
  expect(named(events(), "workspace.container.idle-stop").at(0)).toMatchObject({
    outcome: "skipped-busy",
  });
  expect(alarms.at(-1)).toBe(21_000);
});

test("work that begins during the stop waits for it through settled()", async () => {
  const { idle, clock } = controller();
  idle.begin()();
  clock.now = 11_000;

  const alarm = idle.onAlarm();
  let waited = false;
  void idle.settled().then(() => {
    waited = true;
  });
  expect(waited).toBe(false);

  await alarm;
  await idle.settled();
  expect(waited).toBe(true);
});

test("a failed close is logged and the container is still destroyed", async () => {
  const events = capturedEvents();
  const { idle, clock, calls } = controller({ closeFails: true });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close", "destroy"]);
  expect(named(events(), "workspace.container.idle-stop").at(0)).toMatchObject({
    outcome: "stopped",
  });
});

test("a failed destroy is a warning that checks again one limit later", async () => {
  const events = capturedEvents();
  const { idle, clock, alarms } = controller({ destroyFails: true });
  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(named(events(), "workspace.container.idle-stop")).toEqual([
    expect.objectContaining({ level: "warn", outcome: "threw", runningBefore: true }),
  ]);
  expect(alarms.at(-1)).toBe(21_000);
});

test("a container that exits during the close is not destroyed", async () => {
  const events = capturedEvents();

  const { idle, clock, calls } = controller({
    duringClose: (world) => {
      world.state.running = false;
    },
  });

  idle.begin()();
  clock.now = 11_000;
  await idle.onAlarm();

  expect(calls).toEqual(["close"]);
  expect(named(events(), "workspace.container.idle-stop").at(0)).toMatchObject({
    outcome: "not-running",
  });
});

test("a second alarm during a stop does not start another", async () => {
  const { idle, clock, calls } = controller();
  idle.begin()();
  clock.now = 11_000;

  await Promise.all([idle.onAlarm(), idle.onAlarm()]);

  expect(calls).toEqual(["close", "destroy"]);
});
