// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The project id and the prompt arrive from a client through the Worker, so neither has a proven shape until this module proves it.
// oxlint-disable import/max-dependencies -- One module holds a turn from admission to the hand-off of its stream, so the order of admission, start, and abandonment reads in one place.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { parseThreadMessages } from "../threads/index.js";
import { TurnBound } from "./turn-bound.js";
import { readTurnStream } from "./turn-stream.js";
import { releaseLease, type TurnThreadWrites } from "./turn-settle.js";
import { logLeaseAbandoned, turnTrace, type TurnTrace } from "./turn-log.js";
import type { ActiveGeneration } from "../generations/index.js";
import type {
  ProjectThreadProblem,
  ProjectThreadResult,
  ProjectTurnLeaseResult,
} from "../threads/index.js";
import type { ProjectTurnRefusal, ProjectTurnStart } from "./project-turn.js";

const PROJECT_TURN_PROMPT_MAX_LENGTH = 32_000;

type TurnThreads = TurnThreadWrites &
  Readonly<{
    read(projectId: unknown): ProjectThreadResult;
    startTurn(
      projectId: unknown,
      expectedRevision: number,
      now: number,
      leaseMs: number,
    ): ProjectTurnLeaseResult;
  }>;

/**
 * The generation parses it again, because it lives in a different isolate and is mutable harness
 * code.
 */
export type FacetTurnHandoff = Readonly<{
  prompt: string;
  messages: readonly unknown[];
}>;

/**
 * Both are fixed at admission, so a generation activated while the turn starts changes what the
 * next turn runs on, not this one.
 */
export type TurnStartContext = Readonly<{
  attribution: TurnAttribution;
  signal: AbortSignal;
  remainingMs: () => number;
  trace: TurnTrace;
}>;

type StartedTurn = Extract<ProjectTurnStart, { ok: true }>;

type TurnAttribution = Readonly<{ active: ActiveGeneration }>;

export type ProjectTurnRunProblemCode =
  | ProjectThreadProblem["code"]
  | ProjectTurnRefusal
  | "invalid-prompt"
  | "workspace-busy";

export type ProjectTurnRun =
  | Readonly<{ ok: true; frames: ReadableStream<Uint8Array> }>
  | Readonly<{ ok: false; problem: Readonly<{ code: ProjectTurnRunProblemCode }> }>;

export type RunProjectTurnInput = Readonly<{
  projectId: unknown;
  prompt: unknown;
  threads: TurnThreads;
  resetting: () => boolean;
  attribution: () => TurnAttribution;
  start: (
    projectId: string,
    request: FacetTurnHandoff,
    context: TurnStartContext,
  ) => Effect.Effect<ProjectTurnStart>;
  now: () => number;
  leaseMs: number;
  deadlineMs: number;
}>;

function refused(code: ProjectTurnRunProblemCode): ProjectTurnRun {
  return { ok: false, problem: { code } };
}

function parsePrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const prompt = value.trim();

  return prompt === "" || prompt.length > PROJECT_TURN_PROMPT_MAX_LENGTH ? undefined : prompt;
}

type AdmittedTurn = Readonly<{
  projectId: string;
  leaseId: string;
  attribution: TurnAttribution;
  bound: TurnBound;
  trace: TurnTrace;
}>;

type Admission =
  | Readonly<{ admitted: true; turn: AdmittedTurn; request: FacetTurnHandoff }>
  | Readonly<{ admitted: false; refusal: ProjectTurnRun }>;

/** Validate, read, and admit, in one synchronous step: no other request runs in between. */
function admit(input: RunProjectTurnInput): Admission {
  const prompt = parsePrompt(input.prompt);

  if (prompt === undefined) {
    return { admitted: false, refusal: refused("invalid-prompt") };
  }

  const current = input.threads.read(input.projectId);

  if (!current.ok) {
    return { admitted: false, refusal: refused(current.problem.code) };
  }

  const history = parseThreadMessages(current.thread.conversation);

  if (Result.isFailure(history)) {
    return { admitted: false, refusal: refused("unreadable-thread") };
  }

  // Checked in the same synchronous step as the lease: a reset that starts after this sees the
  // lease, and a turn that arrives after the reset started is refused here.
  if (input.resetting()) {
    return { admitted: false, refusal: refused("workspace-busy") };
  }

  const attribution = input.attribution();
  const admittedAt = input.now();

  const admitted = input.threads.startTurn(
    input.projectId,
    current.thread.revision,
    admittedAt,
    input.leaseMs,
  );

  if (!admitted.ok) {
    return { admitted: false, refusal: refused(admitted.problem.code) };
  }

  return {
    admitted: true,
    turn: admittedTurn(input, admitted, attribution, admittedAt),
    request: { prompt, messages: history.success },
  };
}

/**
 * The thread revision admission presents is the one read here, so a client cannot choose it. The
 * lease id stays here: no response carries it, so nothing outside this Supervisor can finish or
 * abandon the turn. Only the wait for the start can be interrupted; once it has answered, the hand-
 * off runs whole, so the lease is owned by exactly one of the stream or the abandonment.
 */
export function runProjectTurn(input: RunProjectTurnInput): Effect.Effect<ProjectTurnRun> {
  return Effect.gen(function* () {
    const admission = yield* Effect.sync(() => admit(input));

    if (!admission.admitted) return admission.refusal;

    const { turn } = admission;

    return yield* Effect.uninterruptibleMask((restore) =>
      restore(boundedStart(input, turn, admission.request)).pipe(
        // A lost RPC rejects instead of returning a refusal. The lease must be released before the
        // exception crosses the boundary.
        Effect.onError((cause) =>
          Effect.sync(() => {
            abandonTurn(
              input,
              turn,
              Cause.hasInterruptsOnly(cause) ? "start-interrupted" : "start-threw",
            );
          }),
        ),
        Effect.map((started) => handOff(input, turn, started)),
      ),
    );
  });
}

function handOff(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  started: ProjectTurnStart | "timed-out",
): ProjectTurnRun {
  if (started === "timed-out") {
    abandonTurn(input, turn, "start-timed-out");

    return refused("turn-not-started");
  }

  if (!started.ok) {
    abandonTurn(input, turn, started.reason);

    return refused(started.reason);
  }

  return { ok: true, frames: streamOrAbandon(input, turn, started) };
}

function admittedTurn(
  input: RunProjectTurnInput,
  admitted: Extract<ProjectTurnLeaseResult, { ok: true }>,
  attribution: TurnAttribution,
  admittedAt: number,
): AdmittedTurn {
  const projectId = admitted.thread.projectId;
  const generation = attribution.active.generation?.label;
  const trace = turnTrace(projectId, admitted.leaseId, generation, admittedAt);

  return {
    projectId,
    leaseId: admitted.leaseId,
    attribution,
    bound: TurnBound.forTurn(admittedAt, input.leaseMs, input.deadlineMs, input.now),
    trace,
  };
}

function streamOrAbandon(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  started: StartedTurn,
): ReadableStream<Uint8Array> {
  try {
    return streamAdmittedTurn(input, turn, started);
  } catch (error) {
    // Building the response stream can fail after the facet started.
    abandonTurn(input, turn, "stream-failed");
    started.workspace.end();
    throw error;
  }
}

function abandonTurn(input: RunProjectTurnInput, turn: AdmittedTurn, why: string): void {
  turn.bound.stop();
  releaseLease({ ...turn, threads: input.threads }, `turn-abandon.${why}`);
  logLeaseAbandoned(turn.trace, why, "warn");
}

/**
 * The start races the turn's own bound, not a fresh timer, so it cannot take the deadline twice. It
 * runs as its own fiber that this turn joins rather than owns, because some steps cannot be
 * recalled once sent: a provisioning plan holds the workspace exclusion until its Workspace Host
 * RPC returns. A start that loses the race is left to finish and is cancelled. The bound has
 * already aborted the turn's signal, which stops native work; interrupting the fiber would only
 * stop the waiting. A facet that answers late has its live stream cancelled, so it cannot keep
 * running tools in the shared workspace after the lease went back.
 */
function boundedStart(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  request: FacetTurnHandoff,
): Effect.Effect<ProjectTurnStart | "timed-out"> {
  const context: TurnStartContext = {
    attribution: turn.attribution,
    signal: turn.bound.signal,
    remainingMs: () => turn.bound.remainingMs(),
    trace: turn.trace,
  };

  return Effect.gen(function* () {
    const starting = yield* Effect.forkDetach(
      Effect.exit(input.start(turn.projectId, request, context)),
      { startImmediately: true },
    );

    return yield* turn.bound
      .within(Fiber.join(starting).pipe(Effect.flatten), "timed-out" as const)
      .pipe(
        Effect.onExit((waited) =>
          Effect.sync(() => {
            if (Exit.isFailure(waited) || waited.value === "timed-out") {
              starting.addObserver(cancelOrphanedStart);
            }
          }),
        ),
      );
  });
}

function cancelOrphanedStart(ended: Exit.Exit<Exit.Exit<ProjectTurnStart>>): void {
  if (Exit.isSuccess(ended) && Exit.isSuccess(ended.value) && ended.value.value.ok) {
    ended.value.value.frames.cancel().then(
      () => {},
      () => {},
    );
    ended.value.value.workspace.end();
  }
}

function streamAdmittedTurn(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  { frames, workspace }: StartedTurn,
): ReadableStream<Uint8Array> {
  return readTurnStream({
    projectId: turn.projectId,
    leaseId: turn.leaseId,
    frames,
    workspace,
    threads: input.threads,
    now: input.now,
    bound: turn.bound,
    trace: turn.trace,
  });
}
