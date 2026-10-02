import { logEvent, logRedactedCause } from "../diagnostics.js";
import { decideIdleStop, type WorkspaceActivity } from "./idle-stop.js";

/** What the project capability reports about its own work. */
export type ProjectActivity = Readonly<{
  /** Mark a unit of work as started; the returned function marks it settled. */
  begin(): () => void;
  /** Mark that work just happened, without holding the workspace busy. */
  touch(): void;
}>;

/** The effects the controller needs. Tests supply fakes; the Host supplies the real ones. */
export type IdleControllerPorts = Readonly<{
  nowMs(): number;
  idleLimitMs: number;
  /** Persist an alarm. The controller logs a rejection and tries again on the next activity. */
  setAlarm(atMs: number): Promise<void>;
  containerRunning(): boolean;
  /** Release the Workspace's hold on the container: this ends computerd's open WebSocket request. */
  closeWorkspace(): Promise<void>;
  /** Destroy the container and record the stop as the Host's own doing. */
  stopContainer(): Promise<void>;
}>;

/** How an idle stop ended. */
export type IdleStopOutcome = "stopped" | "not-running" | "skipped-busy" | "threw";

/**
 * Tracks the Workspace Host's work and arms the alarm that later checks for idleness (ADR-0036: the
 * decision is `decideIdleStop`; this is the shell around it). It holds counters in memory only.
 *
 * When the alarm finds the container idle it stops it. The alarm is armed once per quiet period and re-armed when it fires and finds the limit not yet
 * reached, so a burst of work writes the alarm at most once. The controller never arms an alarm
 * while no container runs, and nothing here is a timer, so it cannot keep the object in memory.
 */
export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  #inFlight = 0;
  #lastActiveAtMs: number;
  #leaseEndsAtMs: number | null = null;
  #armed = false;
  #stopping: Promise<void> | undefined;

  constructor(ports: IdleControllerPorts) {
    this.#ports = ports;
    this.#lastActiveAtMs = ports.nowMs();
  }

  begin(): () => void {
    this.#inFlight += 1;
    let ended = false;

    return () => {
      if (ended) return;

      ended = true;
      this.#inFlight -= 1;
      this.#lastActiveAtMs = this.#ports.nowMs();
      this.#armForQuietPeriod();
    };
  }

  touch(): void {
    this.#lastActiveAtMs = this.#ports.nowMs();
    this.#armForQuietPeriod();
  }

  /** Work may still arrive until `endsAtMs`, the end of a turn a project capability was handed to. */
  leaseUntil(endsAtMs: number): void {
    this.#leaseEndsAtMs = Math.max(this.#leaseEndsAtMs ?? 0, endsAtMs);
    this.#armForQuietPeriod();
  }

  snapshot(): WorkspaceActivity {
    return {
      inFlight: this.#inFlight,
      lastActiveAtMs: this.#lastActiveAtMs,
      leaseEndsAtMs: this.#leaseEndsAtMs,
    };
  }

  #armForQuietPeriod(): void {
    if (this.#armed || !this.#ports.containerRunning()) return;

    const activity = this.snapshot();
    const idleSinceMs = Math.max(activity.lastActiveAtMs, activity.leaseEndsAtMs ?? 0);
    this.#arm(idleSinceMs + this.#ports.idleLimitMs);
  }

  #arm(atMs: number): void {
    this.#armed = true;

    this.#ports.setAlarm(atMs).catch((cause: unknown) => {
      logRedactedCause("workspace.idle-alarm: not armed", cause);
      this.#armed = false;
    });
  }

  /** Forget the alarm this instance armed, because storage may have dropped it. Work re-arms it. */
  forgetAlarm(): void {
    this.#armed = false;
  }

  /** Settles once any stop in progress has finished. Work calls this after it has begun. */
  settled(): Promise<void> {
    return this.#stopping ?? Promise.resolve();
  }

  /**
   * Handle the alarm: decide, and when the limit has passed with nothing in flight, stop the
   * container. It re-arms only while a container runs, and only for a later check.
   */
  async onAlarm(): Promise<void> {
    this.#armed = false;
    const nowMs = this.#ports.nowMs();
    const running = this.#ports.containerRunning();
    const activity = this.snapshot();
    const decision = decideIdleStop(activity, nowMs, this.#ports.idleLimitMs);

    logEvent("info", "workspace.idle-check", {
      inFlight: activity.inFlight,
      idleForMs: Math.max(
        0,
        nowMs - Math.max(activity.lastActiveAtMs, activity.leaseEndsAtMs ?? 0),
      ),
      idleLimitMs: this.#ports.idleLimitMs,
      running,
      decision: decision.kind,
    });

    if (!running) return;

    if (decision.kind === "check-at") {
      this.#arm(decision.atMs);

      return;
    }

    if (this.#stopping !== undefined) return;

    this.#stopping = this.#stop(decision.idleForMs, nowMs).finally(() => {
      this.#stopping = undefined;
    });

    await this.#stopping;
  }

  /**
   * Close the Workspace, then destroy the container if nothing began meanwhile. Work that begins
   * during the close keeps the container: the close only drops the WebSocket, and that work
   * connects again and adopts the running container. A failed close does not stop the destroy,
   * because destroying the container also ends the WebSocket from the other side.
   */
  async #stop(idleForMs: number, startedAtMs: number): Promise<void> {
    const runningBefore = this.#ports.containerRunning();
    logEvent("info", "workspace.container.stop-requested", { reasonCode: "idle" });
    let outcome: IdleStopOutcome;

    try {
      await this.#closeWorkspace();
      outcome = await this.#destroyIfStillIdle();
    } catch (cause) {
      logRedactedCause("workspace.idle-stop: container not stopped", cause);
      outcome = "threw";
    }

    logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
      idleForMs,
      idleLimitMs: this.#ports.idleLimitMs,
      runningBefore,
      outcome,
      durationMs: this.#ports.nowMs() - startedAtMs,
    });

    // The container still runs after a busy skip or a failed destroy, so look again later.
    if (outcome === "skipped-busy" || outcome === "threw") {
      this.#arm(this.#ports.nowMs() + this.#ports.idleLimitMs);
    }
  }

  async #closeWorkspace(): Promise<void> {
    try {
      await this.#ports.closeWorkspace();
    } catch (cause) {
      logRedactedCause("workspace.idle-stop: workspace close failed", cause);
    }
  }

  async #destroyIfStillIdle(): Promise<IdleStopOutcome> {
    if (this.#inFlight > 0) return "skipped-busy";

    if (!this.#ports.containerRunning()) return "not-running";

    await this.#ports.stopContainer();

    return "stopped";
  }
}
