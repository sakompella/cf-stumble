import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { runAtEntryPoint } from "../run-entry-point.js";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import type { ExecBackend } from "./project/index.js";
import { decideIdleStop, type WorkspaceActivity } from "./idle-stop.js";

export type ProjectActivity = Readonly<{
  begin(): () => void;
  touch(): void;
}>;

type IdleControllerPorts = Readonly<{
  nowMs(): number;
  idleLimitMs: number;
  setAlarm(atMs: number): Promise<void>;
  containerRunning(): boolean;
  closeWorkspace(): Promise<void>;
  stopContainer(reason: "idle" | "backend"): Promise<void>;
}>;

class IdlePortFailed extends Data.TaggedError("IdlePortFailed")<{ cause: unknown }> {}

function attempt<A>(call: () => Promise<A>): Effect.Effect<A, IdlePortFailed> {
  return Effect.tryPromise({ try: call, catch: (cause) => new IdlePortFailed({ cause }) });
}

function atEntryPoint(program: Effect.Effect<void, IdlePortFailed>): Promise<void> {
  return runAtEntryPoint(
    program.pipe(Effect.catchTag("IdlePortFailed", ({ cause }) => Effect.die(cause))),
  );
}

export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  #inFlight = 0;
  #lastActiveAtMs: number;
  readonly #leases = new Set<Readonly<{ endsAtMs: number }>>();
  #alarmAtMs: number | null = null;
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
    return this.#stopping ?? Promise.resolve();
  }

  #armForQuietPeriod(): void {
    if (!this.#ports.containerRunning()) return;

    const { lastActiveAtMs, leaseEndsAtMs } = this.snapshot();
    const dueAtMs = Math.max(lastActiveAtMs, leaseEndsAtMs ?? 0) + this.#ports.idleLimitMs;

    if (this.#alarmAtMs !== null && this.#alarmAtMs <= dueAtMs) return;

    void runAtEntryPoint(this.#arm(dueAtMs).pipe(Effect.ignore));
  }

  #arm(atMs: number): Effect.Effect<void, IdlePortFailed> {
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
    return atEntryPoint(this.#onAlarm());
  }

  #onAlarm(): Effect.Effect<void, IdlePortFailed> {
    return Effect.suspend(() => {
      this.#alarmAtMs = null;

      if (!this.#ports.containerRunning() || this.#stopping !== undefined) return Effect.void;

      const decision = decideIdleStop(
        this.snapshot(),
        this.#ports.nowMs(),
        this.#ports.idleLimitMs,
      );

      if (decision.kind === "check-at") return this.#arm(decision.atMs);

      return this.#whileStopping(this.#stop(decision.idleForMs));
    });
  }

  stopForBackendChange(): Promise<void> {
    return atEntryPoint(
      Effect.suspend(() => {
        if (!this.#ports.containerRunning() || this.#stopping !== undefined) return Effect.void;

        return this.#whileStopping(
          attempt(() => this.#ports.closeWorkspace()).pipe(
            Effect.andThen(attempt(() => this.#ports.stopContainer("backend"))),
          ),
        );
      }),
    );
  }

  #whileStopping<E>(stop: Effect.Effect<void, E>): Effect.Effect<void, E> {
    return Effect.suspend(() => {
      this.#stopping = new Promise((done) => {
        this.#finishStop = done;
      });

      return stop;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.#stopping = undefined;
          this.#finishStop();
        }),
      ),
    );
  }

  #stop(idleForMs: number): Effect.Effect<void, IdlePortFailed> {
    return attempt(() => this.#ports.closeWorkspace()).pipe(
      Effect.catchTag("IdlePortFailed", ({ cause }) =>
        Effect.sync(() => {
          logRedactedCause("workspace.idle-stop: workspace close failed", cause);
        }),
      ),
      Effect.andThen(this.#destroyIfStillIdle()),
      Effect.flatMap((outcome) => {
        logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
          idleForMs,
          outcome,
        });

        return outcome === "skipped-busy" || outcome === "threw"
          ? this.#arm(this.#ports.nowMs() + this.#ports.idleLimitMs)
          : Effect.void;
      }),
    );
  }

  #destroyIfStillIdle(): Effect.Effect<"stopped" | "not-running" | "skipped-busy" | "threw"> {
    return Effect.suspend(() => {
      const decision = decideIdleStop(
        this.snapshot(),
        this.#ports.nowMs(),
        this.#ports.idleLimitMs,
      );

      if (decision.kind !== "stop") return Effect.succeed("skipped-busy" as const);

      if (!this.#ports.containerRunning()) return Effect.succeed("not-running" as const);

      return attempt(() => this.#ports.stopContainer("idle")).pipe(
        Effect.as("stopped" as const),
        Effect.catchTag("IdlePortFailed", ({ cause }) =>
          Effect.sync(() => {
            logRedactedCause("workspace.idle-stop: container not stopped", cause);

            return "threw" as const;
          }),
        ),
      );
    });
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
