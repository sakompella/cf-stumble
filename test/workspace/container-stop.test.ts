import { afterEach, expect, test, vi } from "vitest";
import { ObservedWorkspaceContainer } from "../../src/workspace/container-observer.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import {
  controlledMonitor,
  FakeContainer,
  fakeContainer,
  settle,
  SPEC,
  watchedContainer,
} from "./container-observer-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a clean exit the Host did not ask for is one info event with the run duration and an unknown source", async () => {
  const events = capturedEvents();
  const { observed, platform, clock } = watchedContainer({ running: false });

  await observed.start(SPEC);
  clock.now = 61_000;
  platform.calls[0]?.resolve();
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({
      level: "info",
      runtimeId: "runtime-1",
      stoppedAtMs: 61_000,
      runDurationMs: 60_000,
      reasonCode: "normal-exit",
      reasonSource: "unknown",
      expected: null,
      exitCode: null,
    }),
  ]);
});

test("a crash with an exit code is an error that carries the code and no message text", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: false });

  await observed.start(SPEC);
  platform.calls[0]?.reject(
    new Error("Container exited with unexpected exit code: 137 secret-text"),
  );
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({ level: "error", reasonCode: "unexpected-exit-code", exitCode: 137 }),
  ]);
  expect(everythingLogged()).not.toContain("secret-text");
});

test("a stop of an adopted container has no run duration", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: true, outcome: "adopted" });

  await observed.start(SPEC);
  platform.calls[0]?.resolve();
  await settle();

  expect(named(events(), "workspace.container.stopped").at(0)).toMatchObject({
    runDurationMs: null,
  });
});

test("the old runtime's exit after a Host restart is logged as application intent", async () => {
  const events = capturedEvents();
  const { inner, observed, platform } = watchedContainer({ running: false });
  inner.runtimeIds.push("runtime-2");

  await observed.start(SPEC);
  await observed.restartFor("workspace-reset", SPEC);
  platform.calls[0]?.resolve();
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({
      level: "info",
      runtimeId: "runtime-1",
      reasonSource: "application-intent",
      expected: true,
    }),
  ]);
});

test("each runtime is watched once and stops once, however often it is adopted", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: true, outcome: "adopted" });

  await observed.start(SPEC);
  await observed.start(SPEC);
  await observed.start(SPEC);
  expect(platform.calls).toHaveLength(1);

  platform.calls[0]?.resolve();
  await settle();

  expect(named(events(), "workspace.container.stopped")).toHaveLength(1);
});

test("no monitor is armed before a launch returns or when it throws", async () => {
  capturedEvents();
  const { observed, platform } = watchedContainer({ running: false, launchFails: true });

  await expect(observed.start(SPEC)).rejects.toThrow();

  expect(platform.calls).toHaveLength(0);
});

test("without a monitor the observer writes no stop event", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: false });

  await observed.start(SPEC);
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([]);
});

test.each([
  ["launched", "unknown", "error"],
  ["relaunched", "application-intent", "info"],
] as const)(
  "a crash that lands while a connect is in flight and the connect returns %s is %s",
  async (outcome, source, level) => {
    const events = capturedEvents();
    const platform = controlledMonitor();
    let open: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const inner = new FakeContainer({ running: true, outcome: "launched" });
    const observed = new ObservedWorkspaceContainer(inner, { monitor: platform.monitor });
    await observed.start(SPEC);
    inner.runtimeIds.push("runtime-2");
    inner.setNext({ gate, outcome });

    const connecting = observed.start(SPEC);
    await settle();
    platform.calls[0]?.reject(new Error("Container exited with unexpected exit code: 137"));
    await settle();
    expect(
      named(events(), "workspace.container.stopped"),
      "held until the connect returns",
    ).toEqual([]);

    open?.();
    await connecting;

    expect(named(events(), "workspace.container.stopped")).toEqual([
      expect.objectContaining({ reasonSource: source, level }),
    ]);
  },
);

test("a monitor that throws while arming never fails the launch", async () => {
  const events = capturedEvents();
  const inner = new FakeContainer({ running: false });

  const observed = new ObservedWorkspaceContainer(inner, {
    monitor: () => {
      throw new Error("monitor is unavailable");
    },
  });

  await expect(observed.start(SPEC)).resolves.toEqual({
    runtimeId: "runtime-1",
    clientSecret: "client-secret",
    outcome: "launched",
  });
  expect(named(events(), "workspace.container.stopped")).toEqual([]);
  expect(named(events(), "workspace.container.started")).toEqual([
    expect.objectContaining({ runtimeId: "runtime-1" }),
  ]);
});

test("a log call that throws never fails the launch", async () => {
  capturedEvents();
  const { observed } = fakeContainer({ running: false });
  vi.spyOn(console, "log").mockImplementation(() => {
    throw new Error("console is broken");
  });

  await expect(observed.start(SPEC)).resolves.toMatchObject({ runtimeId: "runtime-1" });
});

test("a monitor that rejects with something other than an Error is still one stop", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: false });

  await observed.start(SPEC);
  platform.calls[0]?.reject("container vanished");
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({ reasonCode: "unknown", exitCode: null }),
  ]);
});

test("the exit code a monitor error reports wins over the one parsed from its text", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: false });

  await observed.start(SPEC);
  platform.calls[0]?.reject(
    Object.assign(new Error("Container exited with unexpected exit code: 1"), { exitCode: 139 }),
  );
  await settle();

  expect(named(events(), "workspace.container.stopped").at(0)).toMatchObject({ exitCode: 139 });
});

test("an unexplained exit that is neither clean nor a crash code is a warning", async () => {
  const events = capturedEvents();
  const { observed, platform } = watchedContainer({ running: false });

  await observed.start(SPEC);
  platform.calls[0]?.reject(new Error("network connection lost"));
  await settle();

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({
      level: "warn",
      reasonCode: "connection-lost",
      reasonSource: "unknown",
    }),
  ]);
});

test("the monitor is armed after the launch returns, and arming adds no timer", async () => {
  vi.useFakeTimers();
  capturedEvents();
  const { inner, observed } = watchedContainer({ running: false });

  await observed.start(SPEC);

  expect(inner.calls).toEqual(["status", "start", "launch-returned", "monitor"]);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
