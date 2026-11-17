import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { runAtEntryPoint } from "../run-entry-point.js";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import { ContainerStopFailed } from "./container-lifecycle.js";
import type { ExecBackend } from "./project/index.js";
import { decideIdleStop, type IdleStopDecision, type WorkspaceActivity } from "./idle-stop.js";

export { WORKSPACE_IDLE_STOP_MS } from "./idle-stop.js";

const FINAL_PULL_TIMEOUT_MS = 60_000;

export type ProjectActivity = Readonly<{
  begin(): () => void;
  touch(): void;
}>;

type IdleControllerPorts = Readonly<{
  nowMs(): number;
  idleLimitMs: number;
  setAlarm(atMs: number): Promise<void>;
  containerRunning(): boolean;
  pullContainer(): Promise<void>;
  closeWorkspace(): Promise<void>;
  stopContainer(reason: "idle" | "backend"): Effect.Effect<void, ContainerStopFailed>;
}>;

type IdleStopOutcome = "stopped" | "not-running" | "skipped-busy" | "threw";

class IdlePortRejected extends Data.TaggedError("IdlePortRejected")<{
  readonly cause: unknown;
}> {}

function attempt(call: () => Promise<void>): Effect.Effect<void, IdlePortRejected> {
  return Effect.tryPromise({ try: call, catch: (cause) => new IdlePortRejected({ cause }) });
}

function atEntryPoint(program: Effect.Effect<void, IdlePortRejected>): Promise<void> {
  return runAtEntryPoint(Effect.catch(program, ({ cause }) => Effect.die(cause)));
}

export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  readonly #stopping = Semaphore.makeUnsafe(1);
  #inFlight = 0;
  #lastActiveAtMs: number;
  readonly #leases = new Set<Readonly<{ endsAtMs: number }>>();
  #alarmAtMs: number | null = null;

  constructor(ports: IdleControllerPorts) {
    this.#ports = ports;
    this.#lastActiveAtMs = ports.nowMs() - ports.idleLimitMs;
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

  lease(endsAtMs: number): () => void {
    const lease = { endsAtMs };
    this.#leases.add(lease);
    this.#armForQuietPeriod();

    return () => {
      if (this.#leases.delete(lease)) this.touch();
    };
  }

  snapshot(): WorkspaceActivity {
    const leaseEnds = [...this.#leases].map((lease) => lease.endsAtMs);

    return {
      inFlight: this.#inFlight,
      lastActiveAtMs: this.#lastActiveAtMs,
      leaseEndsAtMs: leaseEnds.length === 0 ? null : Math.max(...leaseEnds),
    };
  }

  forgetAlarm(): void {
    this.#alarmAtMs = null;
  }

  settled(): Promise<void> {
    return runAtEntryPoint(this.#stopping.withPermits(1)(Effect.void));
  }

  #armForQuietPeriod(): void {
    if (!this.#ports.containerRunning()) return;

    const { lastActiveAtMs, leaseEndsAtMs } = this.snapshot();
    const dueAtMs = Math.max(lastActiveAtMs, leaseEndsAtMs ?? 0) + this.#ports.idleLimitMs;

    if (this.#alarmAtMs !== null && this.#alarmAtMs <= dueAtMs) return;

    void runAtEntryPoint(this.#arm(dueAtMs).pipe(Effect.ignore));
  }

  #arm(atMs: number): Effect.Effect<void, IdlePortRejected> {
    return Effect.suspend(() => {
      this.#alarmAtMs = atMs;

      return attempt(() => this.#ports.setAlarm(atMs));
    }).pipe(
      Effect.tapError(({ cause }) =>
        Effect.sync(() => {
          this.#alarmAtMs = null;
          logRedactedCause("workspace.idle-alarm: not armed", cause);
        }),
      ),
    );
  }

  onAlarm(): Promise<void> {
    return atEntryPoint(this.#stopping.withPermits(1)(this.#idleStop()));
  }

  stopForBackendChange(): Promise<void> {
    return atEntryPoint(this.#stopping.withPermits(1)(this.#backendStop()));
  }

  #decision(): IdleStopDecision {
    return decideIdleStop(this.snapshot(), this.#ports.nowMs(), this.#ports.idleLimitMs);
  }

  #idleStop(): Effect.Effect<void, IdlePortRejected> {
    return Effect.suspend(() => {
      this.#alarmAtMs = null;

      if (!this.#ports.containerRunning()) return Effect.void;

      const decision = this.#decision();

      if (decision.kind === "check-at") return this.#arm(decision.atMs);

      return this.#stopIdle().pipe(
        Effect.flatMap((outcome) => {
          logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
            idleForMs: decision.idleForMs,
            outcome,
          });

          return outcome === "stopped" || outcome === "not-running"
            ? Effect.void
            : this.#arm(this.#retryAtMs());
        }),
      );
    });
  }

  #stopIdle(): Effect.Effect<IdleStopOutcome> {
    return this.#close().pipe(
      Effect.andThen(
        Effect.suspend((): Effect.Effect<IdleStopOutcome> => {
          if (this.#decision().kind !== "stop") return Effect.succeed("skipped-busy");

          if (!this.#ports.containerRunning()) return Effect.succeed("not-running");

          return this.#destroy("idle").pipe(
            Effect.as<IdleStopOutcome>("stopped"),
            Effect.orElseSucceed((): IdleStopOutcome => "threw"),
          );
        }),
      ),
    );
  }

  #backendStop(): Effect.Effect<void, IdlePortRejected> {
    return Effect.suspend(() =>
      this.#ports.containerRunning()
        ? this.#close().pipe(
            Effect.andThen(this.#destroy("backend")),
            Effect.tapError(() => this.#arm(this.#retryAtMs()).pipe(Effect.ignore)),
          )
        : Effect.void,
    );
  }

  #close(): Effect.Effect<void> {
    return attempt(() => this.#ports.pullContainer()).pipe(
      Effect.timeout(FINAL_PULL_TIMEOUT_MS),
      Effect.catch((failure) =>
        Effect.sync(() => {
          logRedactedCause(
            "workspace.idle-stop: final pull failed",
            Cause.isTimeoutError(failure) ? failure : failure.cause,
          );
          logEvent("warn", "workspace.container.idle-stop", { outcome: "writes-may-be-lost" });
        }),
      ),
      Effect.andThen(attempt(() => this.#ports.closeWorkspace())),
      Effect.catch(({ cause }) =>
        Effect.sync(() => {
          logRedactedCause("workspace.idle-stop: workspace close failed", cause);
        }),
      ),
    );
  }

  #destroy(reason: "idle" | "backend"): Effect.Effect<void, IdlePortRejected> {
    return this.#ports.stopContainer(reason).pipe(
      Effect.catchCause((failed) => {
        const squashed = Cause.squash(failed);
        const cause = squashed instanceof ContainerStopFailed ? squashed.cause : squashed;
        logRedactedCause("workspace.idle-stop: container not stopped", cause);

        return Effect.fail(new IdlePortRejected({ cause }));
      }),
    );
  }

  #retryAtMs(): number {
    return this.#ports.nowMs() + this.#ports.idleLimitMs;
  }
}

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
