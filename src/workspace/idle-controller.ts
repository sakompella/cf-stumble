import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { runAtEntryPoint } from "../run-entry-point.js";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import type { ExecBackend } from "./project/index.js";
import {
  decideIdleStop,
  nextStopStep,
  StopCommand,
  StopEvent,
  StopPhase,
  stopLatch,
  type WorkspaceActivity,
} from "./idle-stop.js";

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
  stopContainer(reason: "idle" | "backend"): Effect.Effect<void, unknown>;
}>;

function attempt(call: () => Promise<void>): Effect.Effect<void, unknown> {
  return Effect.tryPromise({ try: call, catch: (cause) => cause });
}

function atEntryPoint(program: Effect.Effect<void, unknown>): Promise<void> {
  return runAtEntryPoint(Effect.orDie(program));
}

export class WorkspaceIdleController implements ProjectActivity {
  readonly #ports: IdleControllerPorts;
  #inFlight = 0;
  #lastActiveAtMs: number;
  readonly #leases = new Set<Readonly<{ endsAtMs: number }>>();
  #alarmAtMs: number | null = null;
  #phase: StopPhase = StopPhase.Idle();

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

  async settled(): Promise<void> {
    await stopLatch(this.#phase)?.ended;
  }

  #armForQuietPeriod(): void {
    if (!this.#ports.containerRunning()) return;

    const { lastActiveAtMs, leaseEndsAtMs } = this.snapshot();
    const dueAtMs = Math.max(lastActiveAtMs, leaseEndsAtMs ?? 0) + this.#ports.idleLimitMs;

    if (this.#alarmAtMs !== null && this.#alarmAtMs <= dueAtMs) return;

    void runAtEntryPoint(this.#arm(dueAtMs).pipe(Effect.ignore));
  }

  #arm(atMs: number): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      this.#alarmAtMs = atMs;

      return attempt(() => this.#ports.setAlarm(atMs));
    }).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          this.#alarmAtMs = null;
          logRedactedCause("workspace.idle-alarm: not armed", cause);
        }),
      ),
    );
  }

  onAlarm(): Promise<void> {
    return atEntryPoint(
      Effect.suspend(() => {
        this.#alarmAtMs = null;

        return this.#feed(
          StopEvent.AlarmFired({
            running: this.#ports.containerRunning(),
            decision: this.#decision(),
          }),
        );
      }),
    );
  }

  async stopForBackendChange(): Promise<void> {
    const started = this.#feed(
      StopEvent.BackendChanged({ running: this.#ports.containerRunning() }),
    );

    const done = stopLatch(this.#phase);
    await atEntryPoint(started.pipe(Effect.ignore));
    const end = await done?.ended;

    if (end?.kind === "failed") throw end.cause;
  }

  #decision() {
    return decideIdleStop(this.snapshot(), this.#ports.nowMs(), this.#ports.idleLimitMs);
  }

  #feed(event: StopEvent): Effect.Effect<void, unknown> {
    const { phase, commands } = nextStopStep(this.#phase, event);
    this.#phase = phase;

    return Effect.forEach(commands, (command) => this.#execute(command), { discard: true });
  }

  #execute(command: StopCommand): Effect.Effect<void, unknown> {
    return StopCommand.$match(command, {
      Arm: ({ atMs }) => this.#arm(atMs),
      Close: () => this.#close(),
      Destroy: ({ reason }) => this.#destroy(reason),
      Report: ({ idleForMs, outcome }) =>
        Effect.sync(() => {
          logEvent(outcome === "threw" ? "warn" : "info", "workspace.container.idle-stop", {
            idleForMs,
            outcome,
          });
        }),
      Finish: ({ done, end }) =>
        Effect.sync(() => {
          done.end(end);
        }),
    });
  }

  #close(): Effect.Effect<void, unknown> {
    return attempt(() => this.#ports.closeWorkspace()).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          logRedactedCause("workspace.idle-stop: workspace close failed", cause);
        }),
      ),
      Effect.andThen(
        Effect.suspend(() =>
          this.#feed(
            StopEvent.Closed({
              running: this.#ports.containerRunning(),
              recheck: this.#decision(),
              retryAtMs: this.#retryAtMs(),
            }),
          ),
        ),
      ),
    );
  }

  #destroy(reason: "idle" | "backend"): Effect.Effect<void, unknown> {
    return this.#ports.stopContainer(reason).pipe(
      Effect.as(null),
      Effect.catchCause((failed) =>
        Effect.sync(() => {
          const cause = Cause.squash(failed);
          logRedactedCause("workspace.idle-stop: container not stopped", cause);

          return { cause };
        }),
      ),
      Effect.flatMap((failure) =>
        this.#feed(StopEvent.Destroyed({ failure, retryAtMs: this.#retryAtMs() })),
      ),
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
