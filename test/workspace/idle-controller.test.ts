import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import { capturedEvents, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const LIMIT = 10_000;

function controller(options: Readonly<{ running?: boolean }> = {}) {
  const clock = { now: 1_000 };
  const state = { running: options.running ?? true };
  const alarms: number[] = [];

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.now,
    idleLimitMs: LIMIT,
    setAlarm: (atMs) => {
      alarms.push(atMs);
    },
    containerRunning: () => state.running,
  });

  return { idle, clock, state, alarms };
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

test("an alarm before the limit re-arms for the moment the limit passes", () => {
  const events = capturedEvents();
  const { idle, clock, alarms } = controller();
  idle.begin()();
  clock.now = 6_000;
  idle.onAlarm();

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

test("an alarm while work is in flight checks again a full limit later", () => {
  const { idle, clock, alarms } = controller();
  idle.begin();
  idle.touch();
  clock.now = 20_000;
  idle.onAlarm();

  expect(alarms.at(-1)).toBe(30_000);
});

test("an alarm that finds the container stopped arms nothing and records it", () => {
  const events = capturedEvents();
  const { idle, clock, state, alarms } = controller();
  idle.begin()();
  state.running = false;
  clock.now = 20_000;
  idle.onAlarm();

  expect(alarms).toHaveLength(1);
  expect(named(events(), "workspace.idle-check").at(0)).toMatchObject({
    running: false,
    decision: "stop",
  });
});

test("an alarm at the limit logs a stop decision and, for now, re-arms nothing", () => {
  const events = capturedEvents();
  const { idle, clock, alarms } = controller();
  idle.begin()();
  clock.now = 11_000;
  idle.onAlarm();

  expect(alarms).toHaveLength(1);
  expect(named(events(), "workspace.idle-check").at(0)).toMatchObject({
    idleForMs: 10_000,
    decision: "stop",
  });
});
