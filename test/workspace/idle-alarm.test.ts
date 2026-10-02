import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import { capturedEvents } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function controller(options: Readonly<{ alarmFails?: boolean }> = {}) {
  const alarms: number[] = [];

  const idle = new WorkspaceIdleController({
    nowMs: () => 1_000,
    idleLimitMs: 10_000,
    setAlarm: (atMs) => {
      alarms.push(atMs);

      return options.alarmFails === true
        ? Promise.reject(new Error("alarm write failed"))
        : Promise.resolve();
    },
    containerRunning: () => true,
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () => Promise.resolve(),
  });

  return { idle, alarms };
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
