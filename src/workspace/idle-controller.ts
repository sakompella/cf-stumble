import { logEvent } from "../diagnostics.js";
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
  /** Persist an alarm. A failure is the caller's to log; it must not fail the work that armed it. */
  setAlarm(atMs: number): void;
  containerRunning(): boolean;
}>;

/**
 * Tracks the Workspace Host's work and arms the alarm that later checks for idleness (ADR-0036: the
 * decision is `decideIdleStop`; this is the shell around it). It holds counters in memory only.
 *
 * The alarm is armed once per quiet period and re-armed when it fires and finds the limit not yet
 * reached, so a burst of work writes the alarm at most once. The controller never arms an alarm
 * while no container runs, and nothing here is a timer, so it cannot keep the object in memory.
 */
export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  #inFlight = 0;
  #lastActiveAtMs: number;
  #leaseEndsAtMs: number | null = null;
  #armed = false;

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
    this.#ports.setAlarm(atMs);
  }

  /**
   * Handle the alarm. For now it only records what it decided; the stop comes in a later change.
   * It re-arms only when the container runs and the limit has not passed.
   */
  onAlarm(): void {
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

    if (running && decision.kind === "check-at") this.#arm(decision.atMs);
  }
}
