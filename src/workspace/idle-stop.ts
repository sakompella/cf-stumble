import * as Data from "effect/Data";

export const WORKSPACE_IDLE_STOP_MS = 10 * 60 * 1_000;

export type WorkspaceActivity = Readonly<{
  inFlight: number;
  lastActiveAtMs: number;
  leaseEndsAtMs: number | null;
}>;

type IdleStopDecision =
  | Readonly<{ kind: "stop"; idleForMs: number }>
  | Readonly<{ kind: "check-at"; atMs: number }>;

export function decideIdleStop(
  activity: WorkspaceActivity,
  nowMs: number,
  idleLimitMs: number,
): IdleStopDecision {
  if (activity.inFlight > 0) return { kind: "check-at", atMs: nowMs + idleLimitMs };

  const idleSinceMs = Math.max(activity.lastActiveAtMs, activity.leaseEndsAtMs ?? 0);
  const dueAtMs = idleSinceMs + idleLimitMs;

  if (nowMs < dueAtMs) return { kind: "check-at", atMs: dueAtMs };

  return { kind: "stop", idleForMs: nowMs - idleSinceMs };
}

type StopEnd = Readonly<
  { kind: "stopped" } | { kind: "kept" } | { kind: "failed"; cause: unknown }
>;

export type Latch = Readonly<{ ended: Promise<StopEnd>; end: (end: StopEnd) => void }>;

const STOPPED: StopEnd = { kind: "stopped" };

const KEPT: StopEnd = { kind: "kept" };

function latch(): Latch {
  const settle = { end: (_end: StopEnd): void => {} };

  const ended = new Promise<StopEnd>((resolve) => {
    settle.end = resolve;
  });

  return {
    ended,
    end: (end) => {
      settle.end(end);
    },
  };
}

type Failure = Readonly<{ cause: unknown }>;

type IdleStop = Readonly<{ idleForMs: number; backendQueued: boolean; done: Latch }>;

export type StopPhase = Data.TaggedEnum<{
  Idle: object;
  ClosingForIdle: IdleStop;
  DestroyingForIdle: IdleStop;
  ClosingForBackend: { readonly done: Latch };
  DestroyingForBackend: { readonly done: Latch };
}>;

export const StopPhase = Data.taggedEnum<StopPhase>();

export type StopEvent = Data.TaggedEnum<{
  AlarmFired: { readonly running: boolean; readonly decision: IdleStopDecision };
  BackendChanged: { readonly running: boolean };
  Closed: {
    readonly running: boolean;
    readonly recheck: IdleStopDecision;
    readonly retryAtMs: number;
  };
  Destroyed: { readonly failure: Failure | null; readonly retryAtMs: number };
}>;

export const StopEvent = Data.taggedEnum<StopEvent>();

type IdleStopOutcome = "stopped" | "not-running" | "skipped-busy" | "threw";

export type StopCommand = Data.TaggedEnum<{
  Arm: { readonly atMs: number };
  Close: object;
  Destroy: { readonly reason: "idle" | "backend" };
  Report: { readonly idleForMs: number; readonly outcome: IdleStopOutcome };
  Finish: { readonly done: Latch; readonly end: StopEnd };
}>;

export const StopCommand = Data.taggedEnum<StopCommand>();

type StopStep = Readonly<{ phase: StopPhase; commands: readonly StopCommand[] }>;

function step(phase: StopPhase, ...commands: readonly StopCommand[]): StopStep {
  return { phase, commands };
}

function finished(done: Latch, end: StopEnd, ...before: readonly StopCommand[]): StopStep {
  return step(StopPhase.Idle(), ...before, StopCommand.Finish({ done, end }));
}

function backendDestroy(done: Latch, ...before: readonly StopCommand[]): StopStep {
  return step(
    StopPhase.DestroyingForBackend({ done }),
    ...before,
    StopCommand.Destroy({ reason: "backend" }),
  );
}

function idleStopped(stop: IdleStop, outcome: IdleStopOutcome, retryAtMs: number): StopStep {
  const report = StopCommand.Report({ idleForMs: stop.idleForMs, outcome });

  if (outcome === "stopped" || outcome === "not-running") {
    return finished(stop.done, STOPPED, report);
  }

  if (stop.backendQueued) return backendDestroy(stop.done, report);

  return finished(stop.done, KEPT, report, StopCommand.Arm({ atMs: retryAtMs }));
}

function idle(event: StopEvent): StopStep {
  return StopEvent.$match(event, {
    AlarmFired: ({ running, decision }) => {
      if (!running) return step(StopPhase.Idle());

      if (decision.kind === "check-at") {
        return step(StopPhase.Idle(), StopCommand.Arm({ atMs: decision.atMs }));
      }

      const stop = { idleForMs: decision.idleForMs, backendQueued: false, done: latch() };

      return step(StopPhase.ClosingForIdle(stop), StopCommand.Close());
    },
    BackendChanged: ({ running }) =>
      running
        ? step(StopPhase.ClosingForBackend({ done: latch() }), StopCommand.Close())
        : step(StopPhase.Idle()),
    Closed: () => step(StopPhase.Idle()),
    Destroyed: () => step(StopPhase.Idle()),
  });
}

function closingForIdle(phase: StopPhase, stop: IdleStop, event: StopEvent): StopStep {
  return StopEvent.$match(event, {
    AlarmFired: () => step(phase),
    BackendChanged: () => step(StopPhase.ClosingForIdle({ ...stop, backendQueued: true })),
    Closed: ({ running, recheck, retryAtMs }) => {
      if (recheck.kind !== "stop") return idleStopped(stop, "skipped-busy", retryAtMs);

      if (!running) return idleStopped(stop, "not-running", retryAtMs);

      return step(StopPhase.DestroyingForIdle(stop), StopCommand.Destroy({ reason: "idle" }));
    },
    Destroyed: () => step(phase),
  });
}

function destroyingForIdle(phase: StopPhase, stop: IdleStop, event: StopEvent): StopStep {
  return StopEvent.$match(event, {
    AlarmFired: () => step(phase),
    BackendChanged: () => step(StopPhase.DestroyingForIdle({ ...stop, backendQueued: true })),
    Closed: () => step(phase),
    Destroyed: ({ failure, retryAtMs }) =>
      idleStopped(stop, failure === null ? "stopped" : "threw", retryAtMs),
  });
}

export function stopLatch(phase: StopPhase): Latch | null {
  return StopPhase.$match(phase, {
    Idle: () => null,
    ClosingForIdle: ({ done }) => done,
    DestroyingForIdle: ({ done }) => done,
    ClosingForBackend: ({ done }) => done,
    DestroyingForBackend: ({ done }) => done,
  });
}

export function nextStopStep(phase: StopPhase, event: StopEvent): StopStep {
  return StopPhase.$match(phase, {
    Idle: () => idle(event),
    ClosingForIdle: (stop) => closingForIdle(phase, stop, event),
    DestroyingForIdle: (stop) => destroyingForIdle(phase, stop, event),
    ClosingForBackend: ({ done }) =>
      StopEvent.$is("Closed")(event) ? backendDestroy(done) : step(phase),
    DestroyingForBackend: ({ done }) => {
      if (!StopEvent.$is("Destroyed")(event)) return step(phase);

      return event.failure === null
        ? finished(done, STOPPED)
        : finished(
            done,
            { kind: "failed", cause: event.failure.cause },
            StopCommand.Arm({ atMs: event.retryAtMs }),
          );
    },
  });
}
