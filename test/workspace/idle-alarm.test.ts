import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import { capturedEvents, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function controller(options: Readonly<{ alarmFails?: boolean; destroyFails?: boolean }> = {}) {
  const alarms: number[] = [];
  const clock = { now: 1_000 };

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.now,
    idleLimitMs: 10_000,
    setAlarm: (atMs) => {
      alarms.push(atMs);

      return options.alarmFails === true
        ? Promise.reject(new Error("alarm write failed"))
        : Promise.resolve();
    },
    containerRunning: () => true,
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () =>
      options.destroyFails === true
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve(),
  });

  return { idle, alarms, clock };
}

test("an alarm that could not be written is tried again on the next activity", async () => {
  capturedEvents();
  const { idle, alarms } = controller({ alarmFails: true });
  idle.begin()();
  await Promise.resolve();
  await Promise.resolve();
  idle.touch();

  expect(alarms).toHaveLength(2);
});

test("an alarm that was written is not written again by later activity", async () => {
  const { idle, alarms } = controller();
  idle.begin()();
  await Promise.resolve();
  idle.touch();

  expect(alarms).toHaveLength(1);
});

test("forgetting the alarm lets the next activity arm a new one", () => {
  const { idle, alarms } = controller();
  idle.begin()();
  idle.touch();
  expect(alarms).toHaveLength(1);

  idle.forgetAlarm();
  idle.touch();
  expect(alarms).toHaveLength(2);
});

test("an alarm that cannot re-arm itself fails, so the platform runs it again", async () => {
  capturedEvents();
  const failing = controller({ alarmFails: true });
  failing.idle.begin()();
  await Promise.resolve();
  await Promise.resolve();
  failing.clock.now = 5_000;

  await expect(failing.idle.onAlarm(), "no later activity will retry the write").rejects.toThrow(
    "alarm write failed",
  );
  expect(failing.alarms, "the re-arm was attempted").toHaveLength(2);

  failing.clock.now = 5_001;
  await expect(
    failing.idle.onAlarm(),
    "the platform's retry tries the write again",
  ).rejects.toThrow();
  expect(failing.alarms).toHaveLength(3);
});

test("activity re-arms after a failed re-arm, because the alarm is no longer considered armed", async () => {
  capturedEvents();
  const { idle, alarms, clock } = controller({ alarmFails: true });
  idle.begin()();
  await Promise.resolve();
  await Promise.resolve();
  clock.now = 5_000;
  await expect(idle.onAlarm()).rejects.toThrow("alarm write failed");
  const before = alarms.length;

  idle.touch();

  expect(alarms.length, "the next activity writes the alarm again").toBe(before + 1);
});

test("a stop whose destroy and retry write both fail logs the stop and fails the alarm", async () => {
  const events = capturedEvents();
  const { idle, clock } = controller({ destroyFails: true, alarmFails: true });
  idle.begin()();
  await Promise.resolve();
  await Promise.resolve();
  clock.now = 11_000;

  await expect(idle.onAlarm()).rejects.toThrow("alarm write failed");
  expect(named(events(), "workspace.container.idle-stop").at(0)).toMatchObject({
    outcome: "threw",
  });
});

test("the idle check records how many times the platform retried the alarm", async () => {
  const events = capturedEvents();
  const { idle } = controller();
  await idle.onAlarm(2);

  expect(named(events(), "workspace.idle-check").at(0)).toMatchObject({ retryCount: 2 });
});
