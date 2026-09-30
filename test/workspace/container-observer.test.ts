import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { afterEach, expect, test, vi } from "vitest";
import { ObservedWorkspaceContainer } from "../../src/workspace/container-observer.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const SPEC: ContainerLaunchSpec = { env: { PORT: "8080" }, enableInternet: true };

type FakeOptions = Readonly<{
  running?: boolean | "status-fails";
  outcome?: ContainerRuntimeInfo["outcome"];
  launchFails?: boolean;
}>;

/** A container API that answers launches and status; any other call is a test mistake. */
class FakeContainer implements IWorkspaceContainerAPI {
  readonly calls: string[] = [];
  readonly #options: FakeOptions;

  constructor(options: FakeOptions) {
    this.#options = options;
  }

  status() {
    this.calls.push("status");

    return this.#options.running === "status-fails"
      ? Promise.reject(new Error("status rpc failed"))
      : Promise.resolve({ running: this.#options.running ?? false, exit: null });
  }

  start(): Promise<ContainerRuntimeInfo> {
    this.calls.push("start");

    return this.#launch();
  }

  restart(): Promise<ContainerRuntimeInfo> {
    this.calls.push("restart");

    return this.#launch();
  }

  #launch(): Promise<ContainerRuntimeInfo> {
    return this.#options.launchFails === true
      ? Promise.reject(new Error("container would not start"))
      : Promise.resolve({
          runtimeId: "runtime-1",
          clientSecret: "client-secret",
          outcome: this.#options.outcome ?? "launched",
        });
  }

  exitInfo(): Promise<null> {
    return Promise.reject(new Error("the observer never reads exit info"));
  }

  setInactivityTimeout(): Promise<void> {
    return Promise.reject(new Error("the observer never sets an inactivity timeout"));
  }

  interceptOutboundHttp(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }

  interceptAllOutboundHttp(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }

  fetchPort(): Promise<Response> {
    return Promise.reject(new Error("not used"));
  }

  port(): Fetcher {
    throw new Error("not used");
  }
}

function fakeContainer(options: FakeOptions = {}) {
  const inner = new FakeContainer(options);

  return { calls: inner.calls, observed: new ObservedWorkspaceContainer(inner) };
}

test("a cold connect logs the wake request and then the launch the container reported", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: false, outcome: "launched" });

  await observed.start(SPEC);

  const lifecycle = events().filter((entry) =>
    String(entry.event).startsWith("workspace.container."),
  );

  expect(lifecycle).toEqual([
    expect.objectContaining({
      event: "workspace.container.wake-requested",
      trigger: "backend-connect",
      runningBefore: false,
      attempt: 1,
    }),
    expect.objectContaining({
      event: "workspace.container.started",
      trigger: "backend-connect",
      outcome: "launched",
      runtimeId: "runtime-1",
      runningBefore: false,
    }),
  ]);
  expect(lifecycle[1]?.startedAtMs).toEqual(expect.any(Number));
  expect(lifecycle[1]?.durationMs).toBeGreaterThanOrEqual(0);
});

test("a connect that adopts a running container logs adopted with no start time and no wake", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: true, outcome: "adopted" });

  await observed.start(SPEC);

  expect(named(events(), "workspace.container.wake-requested")).toEqual([]);
  expect(named(events(), "workspace.container.started")).toEqual([]);
  expect(named(events(), "workspace.container.adopted")).toEqual([
    expect.objectContaining({ outcome: "adopted", startedAtMs: null, runningBefore: true }),
  ]);
});

test("a connect that finds a running container but relaunches it is logged as started", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: true, outcome: "relaunched" });

  await observed.start(SPEC);

  expect(named(events(), "workspace.container.started")).toEqual([
    expect.objectContaining({ outcome: "relaunched", runningBefore: true }),
  ]);
});

test.each([
  ["backend-recovery", (observed: ObservedWorkspaceContainer) => observed.restart(SPEC)],
  [
    "workspace-reset",
    (observed: ObservedWorkspaceContainer) => observed.restartFor("workspace-reset", SPEC),
  ],
] as const)(
  "a %s restart always logs the wake request, even over a running container",
  async (trigger, restart) => {
    const events = capturedEvents();
    const { observed, calls } = fakeContainer({ running: true });

    await restart(observed);

    expect(calls).toEqual(["status", "restart"]);
    expect(named(events(), "workspace.container.wake-requested")).toEqual([
      expect.objectContaining({ trigger, runningBefore: true, attempt: 1 }),
    ]);
    expect(named(events(), "workspace.container.started")).toEqual([
      expect.objectContaining({ trigger }),
    ]);
  },
);

test("attempts count the launch requests one observer has seen", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: false });

  await observed.start(SPEC);
  await observed.restart(SPEC);

  expect(
    named(events(), "workspace.container.wake-requested").map((entry) => entry.attempt),
  ).toEqual([1, 2]);
});

test("an unreadable status leaves runningBefore unknown and still logs the wake", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: "status-fails" });

  await observed.start(SPEC);

  expect(named(events(), "workspace.container.wake-requested")).toEqual([
    expect.objectContaining({ runningBefore: null }),
  ]);
});

test("a launch that throws writes no started event and rethrows the same error", async () => {
  const events = capturedEvents();
  const { observed } = fakeContainer({ running: false, launchFails: true });

  await expect(observed.start(SPEC)).rejects.toThrow("container would not start");

  expect(named(events(), "workspace.container.started")).toEqual([]);
  expect(named(events(), "workspace.container.adopted")).toEqual([]);
});

test("the client secret the container returned never reaches the log", async () => {
  capturedEvents();
  const { observed } = fakeContainer({ running: false });

  await observed.start(SPEC);

  expect(everythingLogged()).not.toContain("client-secret");
});

test("observing adds no timer and reads status only once per launch", async () => {
  vi.useFakeTimers();
  capturedEvents();
  const { observed, calls } = fakeContainer({ running: false });

  await observed.start(SPEC);

  expect(calls).toEqual(["status", "start"]);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
