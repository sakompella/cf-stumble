import * as Data from "effect/Data";
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
  /** Persist an alarm. The controller logs a rejection and tries again on the next activity. */
  setAlarm(atMs: number): Promise<void>;
  containerRunning(): boolean;
  /** Release the Workspace's hold on the container: this ends computerd's open WebSocket request. */
  closeWorkspace(): Promise<void>;
  /** Destroy the container and record the stop as the Host's own doing. */
  stopContainer(): Promise<void>;
}>;

/** The alarm could not be written. `cause` is what storage threw. */
class IdleAlarmNotWritten extends Data.TaggedError("IdleAlarmNotWritten")<{
  readonly cause: unknown;
}> {}

/** The platform refused to destroy the container. */
class ContainerNotStopped extends Data.TaggedError("ContainerNotStopped")<{
  readonly cause: unknown;
}> {}

/** How an idle stop ended. */
type IdleStopOutcome = "stopped" | "not-running" | "skipped-busy" | "threw";

/**
 * Tracks the Workspace Host's work and arms the alarm that later checks for idleness (ADR-0036: the
 * decision is `decideIdleStop`; this is the shell around it). It holds counters in memory only.
 *
 * When the alarm finds the container idle it stops it. The alarm is armed once per quiet period
 * and re-armed when it fires and finds the limit not yet reached, so a burst of work writes the
 * alarm at most once. The controller never arms an alarm while no container runs, and nothing here
 * is a timer, so it cannot keep the object in memory.
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

  /** Arm from work: a failed write is logged and must not fail the work. Later activity retries. */
  #arm(atMs: number): void {
    this.#armed = true;

    this.#ports.setAlarm(atMs).catch((cause: unknown) => {
      logRedactedCause("workspace.idle-alarm: not armed", cause);
      this.#armed = false;
    });
  }

  /**
   * Arm from the alarm itself. No work may follow to retry a failed write, so the rejection
   * becomes the alarm's own rejection and the platform runs the alarm again.
   */
  #rearm(atMs: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#armed = true;

      return Effect.tryPromise({
        try: () => this.#ports.setAlarm(atMs),
        catch: (cause) => new IdleAlarmNotWritten({ cause }),
      });
    }).pipe(
      Effect.catchTag("IdleAlarmNotWritten", ({ cause }) => {
        logRedactedCause("workspace.idle-alarm: re-arm failed", cause);
        this.#armed = false;

        return Effect.die(cause);
      }),
    );
  }

  /** Forget the alarm this instance armed, because storage may have dropped it. Work re-arms it. */
  forgetAlarm(): void {
    this.#armed = false;
  }

  /** Whether an idle stop is in progress. */
  stopping(): boolean {
    return this.#stopping !== undefined;
  }

  /** Settles once any stop in progress has finished. Work calls this after it has begun. */
  settled(): Promise<void> {
    return this.#stopping ?? Promise.resolve();
  }

  /**
   * Handle the alarm: decide, and when the limit has passed with nothing in flight, stop the
   * container. It re-arms only while a container runs, and only for a later check.
   */
  onAlarm(retryCount = 0): Effect.Effect<void> {
    return Effect.suspend(() => {
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
        retryCount,
      });

      if (!running) return Effect.void;

      if (decision.kind === "check-at") return this.#rearm(decision.atMs);

      if (this.#stopping !== undefined) return Effect.void;

      // Set before the stop runs: its first step is synchronous, and work or a close callback that
      // arrives during it must already see the stop.
      this.#stopping = new Promise<void>((done) => {
        this.#finishStop = done;
      });

      return this.#stop(decision.idleForMs, nowMs).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#stopping = undefined;
            this.#finishStop();
          }),
        ),
      );
    });
  }

  /**
   * Close the Workspace, then destroy the container if nothing began meanwhile. Work that begins
   * during the close keeps the container: the close only drops the WebSocket, and that work
   * connects again and adopts the running container. A failed close does not stop the destroy,
   * because destroying the container also ends the WebSocket from the other side.
   */
  #stop(idleForMs: number, startedAtMs: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const runningBefore = this.#ports.containerRunning();
      logEvent("info", "workspace.container.stop-requested", { reasonCode: "idle-stop" });

      const outcome = yield* this.#closeWorkspace().pipe(
        Effect.andThen(this.#destroyIfStillIdle()),
        Effect.catchTag("ContainerNotStopped", ({ cause }) => this.#threw(cause)),
        Effect.catchDefect((cause) => this.#threw(cause)),
      );

      logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
        idleForMs,
        idleLimitMs: this.#ports.idleLimitMs,
        runningBefore,
        outcome,
        durationMs: this.#ports.nowMs() - startedAtMs,
      });

      // The container still runs after a busy skip or a failed destroy, so look again later.
      if (outcome === "skipped-busy" || outcome === "threw") {
        yield* this.#rearm(this.#ports.nowMs() + this.#ports.idleLimitMs);
      }
    });
  }

  #threw(cause: unknown): Effect.Effect<IdleStopOutcome> {
    return Effect.sync(() => {
      logRedactedCause("workspace.idle-stop: container not stopped", cause);

      return "threw";
    });
  }

  #closeWorkspace(): Effect.Effect<void> {
    return Effect.tryPromise({
      try: () => this.#ports.closeWorkspace(),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          logRedactedCause("workspace.idle-stop: workspace close failed", cause);
        }),
      ),
    );
  }

  #destroyIfStillIdle(): Effect.Effect<IdleStopOutcome, ContainerNotStopped> {
    return Effect.suspend(() => {
      // Decide again on a fresh snapshot: work, or a turn lease taken during the close, cancels the stop.
      const decision = decideIdleStop(
        this.snapshot(),
        this.#ports.nowMs(),
        this.#ports.idleLimitMs,
      );

      if (decision.kind !== "stop") return Effect.succeed("skipped-busy" as const);

      if (!this.#ports.containerRunning()) return Effect.succeed("not-running" as const);

      return Effect.tryPromise({
        try: () => this.#ports.stopContainer(),
        catch: (cause) => new ContainerNotStopped({ cause }),
      }).pipe(Effect.as("stopped" as const));
    });
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
