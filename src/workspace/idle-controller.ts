import * as Effect from "effect/Effect";
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
  stopContainer(): Promise<void>;
}>;

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

    this.#arm(dueAtMs).catch(() => {});
  }

  async #arm(atMs: number): Promise<void> {
    this.#alarmAtMs = atMs;

    try {
      await this.#ports.setAlarm(atMs);
    } catch (cause) {
      this.#alarmAtMs = null;
      logRedactedCause("workspace.idle-alarm: not armed", cause);

      throw cause;
    }
  }

  async onAlarm(): Promise<void> {
    this.#alarmAtMs = null;

    if (!this.#ports.containerRunning() || this.#stopping !== undefined) return;

    const decision = decideIdleStop(this.snapshot(), this.#ports.nowMs(), this.#ports.idleLimitMs);

    if (decision.kind === "check-at") return this.#arm(decision.atMs);

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
