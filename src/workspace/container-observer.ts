import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import { containerReasonCode } from "./backend-sync-ignore.js";
import { NORMAL_STOP, stopCause, stopLevel, type StopCause } from "./container-stop-cause.js";

type LaunchKind = "start" | "restart";

/** Observation must never fail a launch, so a throw while logging or arming is logged and dropped. */
function observeSafely(step: () => void): void {
  try {
    step();
  } catch (cause) {
    try {
      logRedactedCause("workspace.container-observer: observation failed", cause);
    } catch {
      // The console itself is broken; there is nowhere left to report.
    }
  }
}

/** Why the Workspace Host asked the container to launch. */
export type ContainerWakeTrigger = "backend-connect" | "backend-recovery" | "workspace-reset";

/**
 * The container API the backend and the Host use, with each launch logged. It delegates every call
 * unchanged. It reads `status()` once per launch, which reads a flag and wakes nothing, and it adds
 * no timer, heartbeat, or poll.
 *
 * `start` is the backend's connect. It adopts a running container or launches one. `restart`
 * is the backend's one recovery after a failed health probe. `restartFor` is the Host's own
 * restart, such as a reset. Only a launch that Computer reports is logged as started: the outcome
 * comes from its return value, and a call that throws writes no started event.
 *
 * `launchSequence` counts the launch requests this Workspace Host instance has seen since it was
 * built. A new instance starts again at 1.
 */
export class ObservedWorkspaceContainer implements IWorkspaceContainerAPI {
  readonly #inner: IWorkspaceContainerAPI;
  readonly #monitor: (() => Promise<void>) | undefined;
  readonly #destroy: ((reason: string) => Promise<void>) | undefined;
  readonly #now: () => number;
  /** Runtimes this instance watches, with when their launch returned (`null` if adopted). */
  readonly #watched = new Map<string, number | null>();
  /** Runtimes the Host stopped for being idle. */
  readonly #idleStopped = new Set<string>();
  /** Runtimes that a later launch replaced on purpose. */
  readonly #replaced = new Set<string>();
  /** Host restarts in progress: the old container's exit during one is the Host's own doing. */
  #restartsInFlight = 0;
  /** Connects in progress: they destroy a running container only when they relaunch it. */
  #startsInFlight = 0;
  /** Whether any connect since the last release relaunched a running container. */
  #relaunchedSinceRelease = false;
  /** Stops seen during a connect, classified when the connect returns. */
  readonly #held: { runtimeId: string; cause: StopCause; stoppedAtMs: number }[] = [];
  #launches = 0;

  constructor(
    inner: IWorkspaceContainerAPI,
    options: Readonly<{
      monitor?: (() => Promise<void>) | undefined;
      destroy?: ((reason: string) => Promise<void>) | undefined;
      now?: () => number;
    }> = {},
  ) {
    this.#inner = inner;
    this.#monitor = options.monitor;
    this.#destroy = options.destroy;
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
    this.#launches += 1;
    const launchSequence = this.#launches;
    const runningBefore = await this.#runningBefore();

    // A backend connect that finds the container running may only adopt it, so it is not a wake yet.
    // If it relaunches instead, `#observeLaunch` writes the wake after the call.
    const wakeWritten = trigger !== "backend-connect" || runningBefore !== true;

    if (wakeWritten) {
      observeSafely(() => {
        this.#logWake({ trigger, runningBefore, launchSequence });
      });
    }

    const startedAt = this.#now();
    const runtime = await this.#runWhileLaunching(kind, run, spec);
    observeSafely(() => {
      this.#observeLaunch({
        trigger,
        runningBefore,
        launchSequence,
        startedAt,
        runtime,
        wakeWritten,
      });
    });

    return runtime;
  }

  #logWake(
    launch: Readonly<{
      trigger: ContainerWakeTrigger;
      runningBefore: boolean | null;
      launchSequence: number;
    }>,
  ): void {
    logEvent("info", "workspace.container.wake-requested", {
      trigger: launch.trigger,
      runningBefore: launch.runningBefore,
      launchSequence: launch.launchSequence,
    });
  }

  #observeLaunch(
    launch: Readonly<{
      trigger: ContainerWakeTrigger;
      runningBefore: boolean | null;
      launchSequence: number;
      startedAt: number;
      runtime: ContainerRuntimeInfo;
      wakeWritten: boolean;
    }>,
  ): void {
    const { runtime } = launch;
    const adopted = runtime.outcome === "adopted";
    const launchedAtMs = adopted ? null : this.#now();

    if (!adopted) this.#markReplaced(runtime.runtimeId);

    if (!adopted && !launch.wakeWritten) this.#logWake(launch);

    logEvent("info", adopted ? "workspace.container.adopted" : "workspace.container.started", {
      trigger: launch.trigger,
      runningBefore: launch.runningBefore,
      launchSequence: launch.launchSequence,
      outcome: runtime.outcome,
      runtimeId: runtime.runtimeId,
      startedAtMs: launchedAtMs,
      durationMs: this.#now() - launch.startedAt,
    });

    // Its own guard: a monitor that throws must not undo the launch event above.
    observeSafely(() => {
      this.#watch(runtime.runtimeId, launchedAtMs);
    });
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
    if (kind === "restart") this.#restartsInFlight += 1;
    else this.#startsInFlight += 1;

    try {
      const runtime = await run(spec);

      if (runtime.outcome === "relaunched") this.#relaunchedSinceRelease = true;

      return runtime;
    } finally {
      if (kind === "restart") {
        this.#restartsInFlight -= 1;
      } else {
        this.#startsInFlight -= 1;

        if (this.#startsInFlight === 0) {
          const relaunched = this.#relaunchedSinceRelease;
          this.#relaunchedSinceRelease = false;

          observeSafely(() => {
            this.#releaseHeldStops(relaunched);
          });
        }
      }
    }
  }

  #releaseHeldStops(intentional: boolean): void {
    for (const { runtimeId, cause, stoppedAtMs } of this.#held.splice(0)) {
      this.#logStopped(runtimeId, cause, stoppedAtMs, intentional);
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
   * own `monitor()`, which ends when the container exits. It is armed once per runtime, after the
   * launch returned, so it never starts a container.
   *
   * A pending `monitor()` prevents eviction until the container exits or for up to 15 minutes.
   * Computer makes the same call, and the residency this second call adds is unmeasured.
   */
  #watch(runtimeId: string, launchedAtMs: number | null): void {
    if (this.#monitor === undefined || this.#watched.has(runtimeId)) return;

    const settled = this.#monitor();
    this.#watched.set(runtimeId, launchedAtMs);

    // A throw while classifying or logging a stop must not become an unhandled rejection.
    void settled.then(
      () => {
        observeSafely(() => {
          this.#stopped(runtimeId, NORMAL_STOP);
        });
      },
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejection can be anything; stopCause reads a message and a code from it.
      (error: unknown) => {
        observeSafely(() => {
          this.#stopped(runtimeId, stopCause(error));
        });
      },
    );
  }

  #stopped(runtimeId: string, cause: StopCause): void {
    // The time is when the monitor settled, even if the stop waits for a connect to return.
    const stoppedAtMs = this.#now();

    if (this.#startsInFlight > 0) {
      this.#held.push({ runtimeId, cause, stoppedAtMs });

      return;
    }

    this.#logStopped(runtimeId, cause, stoppedAtMs, this.#restartsInFlight > 0);
  }

  #logStopped(
    runtimeId: string,
    cause: StopCause,
    stoppedAtMs: number,
    duringRestart: boolean,
  ): void {
    const launchedAtMs = this.#watched.get(runtimeId) ?? null;
    const idleStop = this.#idleStopped.has(runtimeId);
    const reasonCode = idleStop ? "idle-stop" : containerReasonCode(cause.reason);
    const intentional = duringRestart || idleStop || this.#replaced.has(runtimeId);
    this.#watched.delete(runtimeId);
    this.#replaced.delete(runtimeId);
    this.#idleStopped.delete(runtimeId);

    const level = stopLevel(reasonCode, intentional);

    logEvent(level, "workspace.container.stopped", {
      runtimeId,
      stoppedAtMs,
      runDurationMs: launchedAtMs === null ? null : stoppedAtMs - launchedAtMs,
      reasonCode,
      reasonSource: intentional ? "application-intent" : "unknown",
      exitCode: cause.exitCode,
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

  /** Destroy the container for being idle; watched runtimes are marked first, so their exit is ours. */
  async stopFor(reason: "idle"): Promise<void> {
    if (this.#destroy === undefined) throw new Error("this container cannot be destroyed");

    for (const runtimeId of this.#watched.keys()) this.#idleStopped.add(runtimeId);

    await this.#destroy(reason).catch((cause: unknown) => {
      this.#idleStopped.clear();

      throw cause;
    });
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
