import { afterEach, expect, test, vi } from "vitest";
import { ObservedWorkspaceContainer } from "../../src/workspace/container-observer.js";
import { capturedEvents, named } from "../log-capture.js";
import {
  controlledMonitor,
  FakeContainer,
  settle,
  SPEC,
  watchedContainer,
} from "./container-observer-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
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

test.each(["returns", "fails"] as const)(
  "a log call that throws while releasing a held stop leaves a connect that %s unchanged",
  async (ending) => {
    capturedEvents();
    const platform = controlledMonitor();
    let open: (() => void) | undefined;

    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const inner = new FakeContainer({ running: true });
    const observed = new ObservedWorkspaceContainer(inner, { monitor: platform.monitor });
    await observed.start(SPEC);
    inner.setNext({ gate, launchFails: ending === "fails" });

    const connecting = observed.start(SPEC);

    const outcome = connecting.then(
      (runtime) => runtime,
      (error: Error) => error,
    );

    await settle();
    platform.calls[0]?.reject(new Error("Container exited with unexpected exit code: 137"));
    await settle();
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console is broken");
    });
    open?.();

    const result = await outcome;

    if (ending === "returns") expect(result).toBe(inner.lastRuntime);
    else expect(result).toEqual(new Error("container would not start"));
  },
);

test("a stop held across overlapping connects is explained if any of them relaunched, however they end", async () => {
  const events = capturedEvents();
  const platform = controlledMonitor();
  const gates: (() => void)[] = [];

  const inner = new FakeContainer({ running: true });
  const observed = new ObservedWorkspaceContainer(inner, { monitor: platform.monitor });
  await observed.start(SPEC);

  const held = async (outcome: "relaunched" | "adopted") => {
    const gate = new Promise<void>((resolve) => {
      gates.push(resolve);
    });

    inner.setNext({ gate, outcome });
    const connecting = observed.start(SPEC);
    await settle();

    return connecting;
  };

  const relaunching = held("relaunched");
  await settle();
  const adopting = held("adopted");
  await settle();
  platform.calls[0]?.reject(new Error("Container exited with unexpected exit code: 137"));
  await settle();

  gates.forEach((open) => {
    open();
  });
  await Promise.all([relaunching, adopting]);

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({ reasonSource: "application-intent" }),
  ]);
});

test("a held stop keeps the time the monitor settled, not the time the connect returned", async () => {
  const events = capturedEvents();
  const { inner, observed, platform, clock } = watchedContainer({ running: true });
  let open: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  await observed.start(SPEC);
  inner.setNext({ gate });

  const connecting = observed.start(SPEC);
  await settle();
  clock.now = 31_000;
  platform.calls[0]?.resolve();
  await settle();
  clock.now = 91_000;
  open?.();
  await connecting;

  expect(named(events(), "workspace.container.stopped")).toEqual([
    expect.objectContaining({ stoppedAtMs: 31_000, runDurationMs: 30_000 }),
  ]);
});
