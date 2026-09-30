import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { logEvent, type LogLevel } from "../diagnostics.js";
import { containerExitCode, containerReasonCode } from "./backend-sync-ignore.js";

type LaunchKind = "start" | "restart";

/** Why the Workspace Host asked the container to launch. */
export type ContainerWakeTrigger = "backend-connect" | "backend-recovery" | "workspace-reset";

/**
 * The container API the backend and the Host use, with each launch logged. It delegates every call
 * unchanged. It reads `status()` once per launch, which reads a flag and wakes nothing, and it adds
 * no timer, heartbeat, or poll.
 *
 * `start` is the backend's first connect. It adopts a running container or launches one. `restart`
 * is the backend's one recovery after a failed health probe. `restartFor` is the Host's own
 * restart, such as a reset. Only a launch that Computer reports is logged as started: the outcome
 * comes from its return value, and a call that throws writes no started event.
 *
 * `attempt` counts the launch requests this Workspace Host instance has seen since it was built. A
 * new instance starts again at 1.
 */
export class ObservedWorkspaceContainer implements IWorkspaceContainerAPI {
  readonly #inner: IWorkspaceContainerAPI;
  readonly #monitor: (() => Promise<void>) | undefined;
  readonly #now: () => number;
  /** Runtimes this instance watches, with when their launch returned (`null` if adopted). */
  readonly #watched = new Map<string, number | null>();
  /** Runtimes that a later launch replaced on purpose. */
  readonly #replaced = new Set<string>();
  /** Host restarts in progress: the old container's exit during one is the Host's own doing. */
  #restartsInFlight = 0;
  /** Connects in progress: they destroy a running container only when they relaunch it. */
  #startsInFlight = 0;
  /** Stops seen during a connect, classified when the connect returns. */
  readonly #held: { runtimeId: string; error: Error | undefined }[] = [];
  #attempts = 0;

  constructor(
    inner: IWorkspaceContainerAPI,
    options: Readonly<{ monitor?: (() => Promise<void>) | undefined; now?: () => number }> = {},
  ) {
    this.#inner = inner;
    this.#monitor = options.monitor;
    this.#now = options.now ?? Date.now;
  }

  start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.#launch("backend-connect", spec, "start", (next) => this.#inner.start(next));
  }

  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.restartFor("backend-recovery", spec);
  }

  restartFor(
    trigger: ContainerWakeTrigger,
    spec: ContainerLaunchSpec,
  ): Promise<ContainerRuntimeInfo> {
    return this.#launch(trigger, spec, "restart", (next) => this.#inner.restart(next));
  }

  async #launch(
    trigger: ContainerWakeTrigger,
    spec: ContainerLaunchSpec,
    kind: LaunchKind,
    run: (spec: ContainerLaunchSpec) => Promise<ContainerRuntimeInfo>,
  ): Promise<ContainerRuntimeInfo> {
    this.#attempts += 1;
    const attempt = this.#attempts;
    const runningBefore = await this.#runningBefore();

    // A first connect that finds the container running may only adopt it, so it is not a wake.
    if (trigger !== "backend-connect" || runningBefore !== true) {
      logEvent("info", "workspace.container.wake-requested", { trigger, runningBefore, attempt });
    }

    const startedAt = Date.now();
    const runtime = await this.#runWhileLaunching(kind, run, spec);
    const adopted = runtime.outcome === "adopted";
    const launchedAtMs = adopted ? null : this.#now();

    if (!adopted) this.#markReplaced(runtime.runtimeId);

    this.#watch(runtime.runtimeId, launchedAtMs);

    logEvent("info", adopted ? "workspace.container.adopted" : "workspace.container.started", {
      trigger,
      runningBefore,
      attempt,
      outcome: runtime.outcome,
      runtimeId: runtime.runtimeId,
      startedAtMs: launchedAtMs,
      durationMs: Date.now() - startedAt,
    });

    return runtime;
  }

  /**
   * A restart always destroys the old container, so its exit during the call is the Host's own
   * doing. A connect destroys one only when it relaunches a running container, so a stop that
   * lands during a connect waits for the result: a relaunch explains it, anything else does not.
   */
  async #runWhileLaunching(
    kind: LaunchKind,
    run: (spec: ContainerLaunchSpec) => Promise<ContainerRuntimeInfo>,
    spec: ContainerLaunchSpec,
  ): Promise<ContainerRuntimeInfo> {
    let relaunched = false;

    if (kind === "restart") this.#restartsInFlight += 1;
    else this.#startsInFlight += 1;

    try {
      const runtime = await run(spec);
      relaunched = runtime.outcome === "relaunched";

      return runtime;
    } finally {
      if (kind === "restart") {
        this.#restartsInFlight -= 1;
      } else {
        this.#startsInFlight -= 1;

        if (this.#startsInFlight === 0) this.#releaseHeldStops(relaunched);
      }
    }
  }

  #releaseHeldStops(intentional: boolean): void {
    for (const { runtimeId, error } of this.#held.splice(0)) {
      this.#logStopped(runtimeId, error, intentional);
    }
  }

  /** A launch that did not adopt replaced every runtime watched before it. */
  #markReplaced(newRuntimeId: string): void {
    for (const runtimeId of this.#watched.keys()) {
      if (runtimeId !== newRuntimeId) this.#replaced.add(runtimeId);
    }
  }

  /**
   * Log the one stop of each runtime this instance sees launch or adopt. This is the platform's
   * own `monitor()`, which Computer also calls and which ends only when the container exits. It is
   * armed once per runtime, after the launch returned, so it never starts a container. An instance
   * that is evicted loses its watch and writes nothing.
   */
  #watch(runtimeId: string, launchedAtMs: number | null): void {
    if (this.#monitor === undefined || this.#watched.has(runtimeId)) return;

    this.#watched.set(runtimeId, launchedAtMs);

    void this.#monitor().then(
      () => {
        this.#stopped(runtimeId);
      },
      (error: Error) => {
        this.#stopped(runtimeId, error);
      },
    );
  }

  #stopped(runtimeId: string, error?: Error): void {
    if (this.#startsInFlight > 0) {
      this.#held.push({ runtimeId, error });

      return;
    }

    this.#logStopped(runtimeId, error, this.#restartsInFlight > 0);
  }

  #logStopped(runtimeId: string, error: Error | undefined, duringRestart: boolean): void {
    const stoppedAtMs = this.#now();
    const launchedAtMs = this.#watched.get(runtimeId) ?? null;
    const reason = error === undefined ? "exited normally" : error.message;
    const reasonCode = containerReasonCode(reason);
    const intentional = duringRestart || this.#replaced.has(runtimeId);
    this.#watched.delete(runtimeId);
    this.#replaced.delete(runtimeId);

    const level: LogLevel = intentional
      ? "info"
      : reasonCode === "unexpected-exit-code"
        ? "error"
        : "warn";

    logEvent(level, "workspace.container.stopped", {
      runtimeId,
      stoppedAtMs,
      runDurationMs: launchedAtMs === null ? null : stoppedAtMs - launchedAtMs,
      reasonCode,
      reasonSource: intentional ? "application-intent" : "unknown",
      exitCode: containerExitCode(reason),
      signal: null,
      expected: intentional ? true : null,
    });
  }

  async #runningBefore(): Promise<boolean | null> {
    try {
      return (await this.#inner.status()).running;
    } catch {
      return null;
    }
  }

  setInactivityTimeout(durationMs: number): Promise<void> {
    return this.#inner.setInactivityTimeout(durationMs);
  }

  status(): ReturnType<IWorkspaceContainerAPI["status"]> {
    return this.#inner.status();
  }

  exitInfo(): ReturnType<IWorkspaceContainerAPI["exitInfo"]> {
    return this.#inner.exitInfo();
  }

  interceptOutboundHttp(...args: Parameters<IWorkspaceContainerAPI["interceptOutboundHttp"]>) {
    return this.#inner.interceptOutboundHttp(...args);
  }

  interceptAllOutboundHttp(
    ...args: Parameters<IWorkspaceContainerAPI["interceptAllOutboundHttp"]>
  ) {
    return this.#inner.interceptAllOutboundHttp(...args);
  }

  fetchPort(...args: Parameters<IWorkspaceContainerAPI["fetchPort"]>) {
    return this.#inner.fetchPort(...args);
  }

  port(...args: Parameters<IWorkspaceContainerAPI["port"]>) {
    return this.#inner.port(...args);
  }
}
