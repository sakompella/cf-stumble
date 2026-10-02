import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@cloudflare/computer/backends/container";
import { vi, type MockInstance } from "vitest";
import { ObservedWorkspaceContainer } from "../../src/workspace/container-observer.js";

export const SPEC: ContainerLaunchSpec = { env: { PORT: "8080" }, enableInternet: true };

export type FakeOptions = Readonly<{
  /** Holds every launch until the test opens the gate. */
  gate?: Promise<void>;
  running?: boolean | "status-fails";
  outcome?: ContainerRuntimeInfo["outcome"];
  launchFails?: boolean;
  destroyFails?: boolean;
}>;

/** A container API that answers launches and status; any other call is a test mistake. */
export class FakeContainer implements IWorkspaceContainerAPI {
  readonly calls: string[] = [];
  #options: FakeOptions;
  /** The runtime id each launch returns, in order; the last one repeats. */
  readonly runtimeIds: string[] = ["runtime-1"];
  #launches = 0;

  constructor(options: FakeOptions) {
    this.#options = options;
  }

  /** Change how the next launches answer. */
  setNext(overrides: FakeOptions): void {
    this.#options = { ...this.#options, ...overrides };
  }

  status() {
    this.calls.push("status");

    return this.#options.running === "status-fails"
      ? Promise.reject(new Error("status rpc failed"))
      : Promise.resolve({ running: this.#options.running ?? false, exit: null });
  }

  /** The spec each launch was asked to use, in order. */
  readonly specs: ContainerLaunchSpec[] = [];
  /** The exact object the last launch returned. */
  lastRuntime: ContainerRuntimeInfo | undefined;
  /** Every pass-through call the observer made, as its name and arguments. */
  readonly passedThrough: (readonly [string, ...(string | number)[]])[] = [];
  readonly exit = { exitedAt: 7, reason: "passed through" };
  readonly response = new Response("passed through");

  readonly fetcher: Fetcher = {
    fetch: () => Promise.resolve(this.response),
    connect: () => {
      throw new Error("not used");
    },
  };

  start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    this.calls.push("start");

    return this.#launch(spec);
  }

  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    this.calls.push("restart");

    return this.#launch(spec);
  }

  async #launch(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    this.specs.push(spec);
    // Read the options now: a later setNext must not change a launch that is already waiting.
    const { gate, launchFails, outcome } = this.#options;
    await gate;

    if (launchFails === true) throw new Error("container would not start");

    this.lastRuntime = {
      runtimeId:
        this.runtimeIds[Math.min(this.#launches++, this.runtimeIds.length - 1)] ?? "runtime-1",
      clientSecret: "client-secret",
      outcome: outcome ?? "launched",
    };
    this.calls.push("launch-returned");

    return this.lastRuntime;
  }

  exitInfo() {
    this.passedThrough.push(["exitInfo"]);

    return Promise.resolve(this.exit);
  }

  setInactivityTimeout(durationMs: number): Promise<void> {
    this.passedThrough.push(["setInactivityTimeout", durationMs]);

    return Promise.resolve();
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void> {
    this.passedThrough.push(["interceptOutboundHttp", host, workspace.binding, workspace.id]);

    return Promise.resolve();
  }

  interceptAllOutboundHttp(workspace: WorkspaceRef, token: string): Promise<void> {
    this.passedThrough.push(["interceptAllOutboundHttp", workspace.binding, workspace.id, token]);

    return Promise.resolve();
  }

  fetchPort(port: number, input: string): Promise<Response> {
    this.passedThrough.push(["fetchPort", port, input]);

    return Promise.resolve(this.response);
  }

  port(port: number): Fetcher {
    this.passedThrough.push(["port", port]);

    return this.fetcher;
  }
}

export function fakeContainer(options: FakeOptions = {}) {
  const inner = new FakeContainer(options);

  return { inner, calls: inner.calls, observed: new ObservedWorkspaceContainer(inner) };
}

/** One platform monitor per call, each settled by the test when the container "exits". */
export function controlledMonitor(order: string[] = []) {
  const pending: { resolve(): void; reject(error: Error | string): void }[] = [];
  /** A spy on each monitor promise's `then`, so a test can read the promise the observer chained. */
  const thens: MockInstance<Promise<void>["then"]>[] = [];

  return {
    calls: pending,
    thens,
    monitor: () => {
      const monitored = new Promise<void>((resolve, reject) => {
        order.push("monitor");
        pending.push({ resolve, reject });
      });

      thens.push(vi.spyOn(monitored, "then"));

      return monitored;
    },
  };
}

export function watchedContainer(options: FakeOptions = {}) {
  const clock = { now: 1_000 };
  const inner = new FakeContainer(options);
  const platform = controlledMonitor(inner.calls);

  const destroyed: string[] = [];

  const observed = new ObservedWorkspaceContainer(inner, {
    monitor: platform.monitor,
    destroy: (reason) => {
      destroyed.push(reason);

      return options.destroyFails === true
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve();
    },
    now: () => clock.now,
  });

  return { inner, platform, observed, clock, destroyed };
}

export const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
