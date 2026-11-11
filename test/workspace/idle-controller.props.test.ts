import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";

const LIMIT = 10_000;

const OPERATIONS = [
  "begin",
  "endWork",
  "touch",
  "lease",
  "endLease",
  "advance",
  "fireAlarm",
  "fireAlarmTwice",
  "containerStops",
  "containerStarts",
] as const;

type Operation = (typeof OPERATIONS)[number];

type Step = readonly [Operation, number];

type Failures = Readonly<{ close: boolean; destroy: boolean; alarm: boolean }>;

type FailureSwitch = { current: Failures };

interface World {
  now: number;
  running: boolean;
  armed: number | null;
  arming: boolean;
  activeStops: number;
  lastActivity: number;
  work: (() => void)[];
  leases: { end: () => void; endsAt: number }[];
  violations: string[];
}

async function settleTasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function newWorld(): World {
  return {
    now: 1_000,
    running: true,
    armed: null,
    arming: false,
    activeStops: 0,
    lastActivity: 1_000,
    work: [],
    leases: [],
    violations: [],
  };
}

async function exclusively(world: World, failure: boolean, message: string): Promise<void> {
  if (world.activeStops > 0) world.violations.push("overlapping stop");
  world.activeStops += 1;
  await Promise.resolve();
  world.activeStops -= 1;

  if (failure) throw new Error(message);
}

function recordDestroyViolations(world: World): void {
  if (world.work.length > 0) world.violations.push("destroyed with work in flight");

  if (world.now - world.lastActivity < LIMIT) world.violations.push("destroyed before the limit");

  if (world.leases.some((lease) => world.now - lease.endsAt < LIMIT)) {
    world.violations.push("destroyed under a lease");
  }

  if (!world.running) world.violations.push("destroyed a stopped container");
}

function makeIdleController(world: World, failures: FailureSwitch): WorkspaceIdleController {
  return new WorkspaceIdleController({
    nowMs: () => world.now,
    idleLimitMs: LIMIT,
    setAlarm: (atMs) => {
      if (world.arming && atMs <= world.now) world.violations.push(`alarm ${atMs} <= ${world.now}`);

      if (failures.current.alarm) return Promise.reject(new Error("alarm write failed"));
      world.armed = atMs;

      return Promise.resolve();
    },
    containerRunning: () => world.running,
    pullContainer: () => exclusively(world, failures.current.close, "pull failed"),
    closeWorkspace: () => exclusively(world, failures.current.close, "close failed"),
    stopContainer: () =>
      Effect.promise(async () => {
        recordDestroyViolations(world);
        await exclusively(world, failures.current.destroy, "destroy failed");
        world.running = false;
      }),
  });
}

async function fireAlarm(
  world: World,
  idle: WorkspaceIdleController,
  copies: number,
): Promise<void> {
  if (world.armed === null) return;
  world.now = Math.max(world.now, world.armed);
  world.armed = null;
  world.arming = true;

  const alarms = Array.from({ length: copies }, () => idle.onAlarm().catch(() => {}));

  await Promise.all(alarms);
  world.arming = false;
}

async function perform(
  [operation, amount]: Step,
  world: World,
  idle: WorkspaceIdleController,
): Promise<void> {
  if (operation === "begin") world.work.push(idle.begin());
  else if (operation === "endWork" && world.work.length > 0) {
    world.work.shift()?.();
    world.lastActivity = world.now;
  } else if (operation === "touch") {
    idle.touch();
    world.lastActivity = world.now;
  } else if (operation === "lease") {
    const endsAt = world.now + amount;
    world.leases.push({ end: idle.lease(endsAt), endsAt });
  } else if (operation === "endLease" && world.leases.length > 0) {
    world.leases.shift()?.end();
    world.lastActivity = world.now;
  } else if (operation === "advance") world.now += amount;
  else if (operation === "fireAlarm") await fireAlarm(world, idle, 1);
  else if (operation === "fireAlarmTwice") await fireAlarm(world, idle, 2);
  else if (operation === "containerStops") world.running = false;
  else if (operation === "containerStarts") {
    world.running = true;
    idle.touch();
    world.lastActivity = world.now;
  }

  await settleTasks();
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runScenario(tc: hegel.TestCase) {
  const failures: FailureSwitch = {
    current: tc.draw(
      gs.sampledFrom([
        { close: false, destroy: false, alarm: false },
        { close: true, destroy: false, alarm: false },
        { close: false, destroy: true, alarm: false },
        { close: false, destroy: false, alarm: true },
        { close: true, destroy: true, alarm: true },
      ] as const),
    ),
  };

  const steps = tc.draw(
    gs.arrays(
      gs.tuples(
        gs.sampledFrom(OPERATIONS),
        gs.integers({ minValue: 0, maxValue: Math.floor(1.5 * LIMIT) }),
      ),
      { maxSize: 12 },
    ),
  );

  const world = newWorld();
  const idle = makeIdleController(world, failures);

  for (const step of steps) await perform(step, world, idle);

  return { failures, world, idle };
}

test("whatever work, leases, alarms, failures and container stops interleave, the container is destroyed only when idle and never twice at once", async () => {
  await hegel.testAsync(
    async (tc) => {
      const { world } = await runScenario(tc);

      expect(world.violations).toEqual([]);
    },
    { testCases: 3_000 },
  );
});

test("once all work and leases have ended, a running container with an alarm armed is destroyed within three alarms of the last failure", async () => {
  await hegel.testAsync(
    async (tc) => {
      const { failures, world, idle } = await runScenario(tc);
      failures.current = { ...failures.current, alarm: false };

      for (const end of [...world.work, ...world.leases.map((lease) => lease.end)]) end();
      world.work = [];
      world.leases = [];
      await settleTasks();

      if (!world.running || world.armed === null) return;

      await perform(["fireAlarm", 0], world, idle);
      failures.current = { close: false, destroy: false, alarm: false };

      for (let fires = 0; fires < 3; fires += 1) await perform(["fireAlarm", 0], world, idle);

      expect(world.running).toBe(false);
    },
    { testCases: 300 },
  );
});
