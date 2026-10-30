import * as Effect from "effect/Effect";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import type { ExecBackend } from "./project/index.js";
import { decideIdleStop, type WorkspaceActivity } from "./idle-stop.js";

/** What the project capability reports about its own work. */
export type ProjectActivity = Readonly<{
  /** Mark a unit of work as started; the returned function marks it settled. */
  begin(): () => void;
  /** Mark that work just happened, without holding the workspace busy. */
  touch(): void;
}>;

/** The effects the controller needs. Tests supply fakes; the Host supplies the real ones. */
type IdleControllerPorts = Readonly<{
  nowMs(): number;
  idleLimitMs: number;
  setAlarm(atMs: number): Promise<void>;
  containerRunning(): boolean;
  /** Release the Workspace's hold on the container: this ends computerd's open WebSocket request. */
  closeWorkspace(): Promise<void>;
  stopContainer(): Promise<void>;
}>;

/**
 * Tracks the Workspace Host's work in memory and stops the container once it has been idle for the
 * limit (the decision is `decideIdleStop`). The alarm is armed once per quiet period and
 * re-armed when it fires early, so a burst of work writes it at most once. Nothing is armed while
 * no container runs, and nothing here is a timer, so it cannot keep the object in memory.
 */
export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  #inFlight = 0;
  #lastActiveAtMs: number;
  #leaseEndsAtMs: number | null = null;
  #armed = false;
  #stopping: Promise<void> | undefined;
  #finishStop: () => void = () => {};

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
      this.touch();
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

  /** Forget the alarm this instance armed, because storage may have dropped it. Work re-arms it. */
  forgetAlarm(): void {
    this.#armed = false;
  }

  /** Settles once any stop in progress has finished. Work calls this after it has begun. */
  settled(): Promise<void> {
    return this.#stopping ?? Promise.resolve();
  }

  /** Activity must not fail because the alarm could not be written; the next activity retries. */
  #armForQuietPeriod(): void {
    if (this.#armed || !this.#ports.containerRunning()) return;

    const { lastActiveAtMs, leaseEndsAtMs } = this.snapshot();
    this.#arm(Math.max(lastActiveAtMs, leaseEndsAtMs ?? 0) + this.#ports.idleLimitMs).catch(
      () => {},
    );
  }

  /** A failed write is logged and rethrown, so an alarm handler that re-arms fails and is retried. */
  async #arm(atMs: number): Promise<void> {
    this.#armed = true;

    try {
      await this.#ports.setAlarm(atMs);
    } catch (cause) {
      this.#armed = false;
      logRedactedCause("workspace.idle-alarm: not armed", cause);

      throw cause;
    }
  }

  async onAlarm(): Promise<void> {
    this.#armed = false;

    if (!this.#ports.containerRunning() || this.#stopping !== undefined) return;

    const decision = decideIdleStop(this.snapshot(), this.#ports.nowMs(), this.#ports.idleLimitMs);

    if (decision.kind === "check-at") return this.#arm(decision.atMs);

    // Set before the stop's synchronous first step, so work that arrives during it waits.
    this.#stopping = new Promise((done) => {
      this.#finishStop = done;
    });

    try {
      await this.#stop(decision.idleForMs);
    } finally {
      this.#stopping = undefined;
      this.#finishStop();
    }
  }

  /**
   * Close the Workspace, then destroy the container if nothing began meanwhile. Work that begins
   * during the close keeps the container: it connects again and adopts the running container. A
   * failed close does not stop the destroy, because the destroy also ends the WebSocket.
   */
  async #stop(idleForMs: number): Promise<void> {
    try {
      await this.#ports.closeWorkspace();
    } catch (cause) {
      logRedactedCause("workspace.idle-stop: workspace close failed", cause);
    }

    const outcome = await this.#destroyIfStillIdle();
    logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
      idleForMs,
      outcome,
    });

    if (outcome === "skipped-busy" || outcome === "threw") {
      await this.#arm(this.#ports.nowMs() + this.#ports.idleLimitMs);
    }
  }

  async #destroyIfStillIdle(): Promise<"stopped" | "not-running" | "skipped-busy" | "threw"> {
    // Decide again: work, or a turn lease taken during the close, cancels the stop.
    const decision = decideIdleStop(this.snapshot(), this.#ports.nowMs(), this.#ports.idleLimitMs);

    if (decision.kind !== "stop") return "skipped-busy";

    if (!this.#ports.containerRunning()) return "not-running";

    try {
      await this.#ports.stopContainer();

      return "stopped";
    } catch (cause) {
      logRedactedCause("workspace.idle-stop: container not stopped", cause);

      return "threw";
    }
  }
}

/**
 * Run one unit of Host work as work in flight, so the idle check never counts it as quiet time.
 *
 * An idle stop in progress sees this work as in flight and keeps the container; the work waits
 * for the stop to finish closing the Workspace before it touches it. The work is uninterruptible:
 * the Host cannot cancel a native Computer call it has made, so an interruption waits for the work
 * to settle, and the work stays counted until it has.
 */
export function trackedWork<A, E>(
  activity: Pick<WorkspaceIdleController, "begin" | "settled">,
  work: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => activity.begin()),
    () =>
      Effect.uninterruptible(Effect.promise(() => activity.settled()).pipe(Effect.andThen(work))),
    (end) => Effect.sync(end),
  );
}

/**
 * An exec backend that waits for an idle stop in progress before it starts a command. The exec has
 * already been counted as in flight, so the stop keeps the container; this only keeps the command
 * from starting on a Workspace that is half closed.
 */
export function afterIdleStop(
  controller: Pick<WorkspaceIdleController, "settled">,
  backend: ExecBackend,
): ExecBackend {
  return {
    async exec(input) {
      await controller.settled();

      return backend.exec(input);
    },
  };
}
