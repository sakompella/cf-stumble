import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { ObservedWorkspaceContainer } from "../../src/workspace/container-observer.js";

export const SPEC: ContainerLaunchSpec = { env: { PORT: "8080" }, enableInternet: true };

export type FakeOptions = Readonly<{
  /** Holds every launch until the test opens the gate. */
  gate?: Promise<void>;
  running?: boolean | "status-fails";
  outcome?: ContainerRuntimeInfo["outcome"];
  launchFails?: boolean;
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

  start(): Promise<ContainerRuntimeInfo> {
    this.calls.push("start");

    return this.#launch();
  }

  restart(): Promise<ContainerRuntimeInfo> {
    this.calls.push("restart");

    return this.#launch();
  }

  async #launch(): Promise<ContainerRuntimeInfo> {
    await this.#options.gate;

    if (this.#options.launchFails === true) throw new Error("container would not start");

    return {
      runtimeId:
        this.runtimeIds[Math.min(this.#launches++, this.runtimeIds.length - 1)] ?? "runtime-1",
      clientSecret: "client-secret",
      outcome: this.#options.outcome ?? "launched",
    };
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

export function fakeContainer(options: FakeOptions = {}) {
  const inner = new FakeContainer(options);

  return { calls: inner.calls, observed: new ObservedWorkspaceContainer(inner) };
}

/** One platform monitor per call, each settled by the test when the container "exits". */
export function controlledMonitor() {
  const pending: { resolve(): void; reject(error: Error | string): void }[] = [];

  return {
    calls: pending,
    monitor: () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
}

export function watchedContainer(options: FakeOptions = {}) {
  const clock = { now: 1_000 };
  const inner = new FakeContainer(options);
  const platform = controlledMonitor();

  const observed = new ObservedWorkspaceContainer(inner, {
    monitor: platform.monitor,
    now: () => clock.now,
  });

  return { inner, platform, observed, clock };
}

export const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
