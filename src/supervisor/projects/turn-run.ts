// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The project id and the prompt arrive from a client through the Worker, so neither has a proven shape until this module proves it.
// oxlint-disable max-lines, import/max-dependencies -- One module holds a turn from admission to the hand-off of its stream, so the order of admission, start, and abandonment reads in one place.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { parseThreadMessages } from "../threads/index.js";
import { TurnBound } from "./turn-bound.js";
import { readTurnStream } from "./turn-stream.js";
import { releaseLease, type TurnThreadWrites } from "./turn-settle.js";
import { logEvent, timedEffect, type TimedOutcome } from "../../diagnostics.js";
import { logLeaseAbandoned, turnFields, turnTrace, type TurnTrace } from "./turn-log.js";
import type { ActiveGeneration } from "../generations/index.js";
import type {
  ProjectThreadProblem,
  ProjectThreadResult,
  ProjectTurnLeaseResult,
} from "../threads/index.js";
import type { ProjectTurnRefusal, ProjectTurnStart } from "./project-turn.js";

/** The longest prompt one turn accepts. Longer input is a refused request, not a truncated one. */
const PROJECT_TURN_PROMPT_MAX_LENGTH = 32_000;

/**
 * The thread surface one turn drives: admission here, and the two writes the running turn makes.
 * `ProjectThreads` satisfies it, and the read and the admission take the client's project id so
 * the catalog resolves it there rather than here.
 */
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
 * What the generation is handed to run a turn: the prompt this request carried and the
 * conversation the Supervisor has saved. The generation parses it again on its own side, because
 * the two live in different isolates and one of them is mutable harness code.
 */
export type FacetTurnHandoff = Readonly<{
  prompt: string;
  messages: readonly unknown[];
}>;

/**
 * What the start path is told about the turn it is starting: the generation this turn runs on, and
 * the turn's one cancellation. Both are fixed at admission, so a generation activated while the
 * turn starts changes what the next turn runs on rather than what this one mounts, and a turn that
 * has ended stops its own start work instead of leaving it to finish unobserved.
 */
export type TurnStartContext = Readonly<{
  attribution: TurnAttribution;
  signal: AbortSignal;
  /** Who this turn is in the operational log, so each start step can report under it. */
  trace: TurnTrace;
}>;

/** The generation a turn runs on, read once at admission and never re-read. */
type TurnAttribution = Readonly<{ active: ActiveGeneration }>;

export type ProjectTurnRunProblemCode =
  | ProjectThreadProblem["code"]
  | ProjectTurnRefusal
  | "invalid-prompt";

export type ProjectTurnRun =
  | Readonly<{ ok: true; frames: ReadableStream<Uint8Array> }>
  | Readonly<{ ok: false; problem: Readonly<{ code: ProjectTurnRunProblemCode }> }>;

export type RunProjectTurnInput = Readonly<{
  /** The client's project id and prompt. These two fields are everything a request may carry. */
  projectId: unknown;
  prompt: unknown;
  threads: TurnThreads;
  attribution: () => TurnAttribution;
  /** Runs the turn on the serving generation. The Supervisor binds the workspace and mount. */
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

/** One admitted turn, as everything after admission sees it. Each field is decided exactly once. */
type AdmittedTurn = Readonly<{
  projectId: string;
  leaseId: string;
  /** The generation the turn runs on. */
  attribution: TurnAttribution;
  /** The instant the turn ends, and the cancellation every step of it honours. */
  bound: TurnBound;
  trace: TurnTrace;
}>;

/**
 * One authenticated project turn, from admission to the stream the browser reads.
 *
 * The order is what makes the turn the server's. The prompt is validated first, because a request
 * that is not a turn should not take a lease. The thread is read next and its revision is the one
 * the admission presents, so a client cannot choose which revision it is admitted at. The lease
 * follows, and the id it mints stays here: no response carries it, so nothing outside this
 * Supervisor can finish or abandon this turn. Admission also fixes the two things the rest of the
 * turn is measured against: the instant the turn ends ({@link TurnBound}) and the generation it
 * runs on, both read once here and never read again. Only then does the work start, and the saved
 * conversation reaches the generation as history the server holds rather than as trusted history
 * a request supplied.
 *
 * The program ends when the browser has its answer. A started turn's answer carries a stream that
 * owns the rest of the turn, including its lease (`turn-stream.ts`).
 */
export function runProjectTurn(input: RunProjectTurnInput): Effect.Effect<ProjectTurnRun> {
  return admitAndStart(input).pipe(
    Effect.tap((run) =>
      Effect.sync(() => {
        if (!run.ok) {
          logEvent(INPUT_REFUSALS.has(run.problem.code) ? "info" : "warn", "turn.refused", {
            projectId: typeof input.projectId === "string" ? input.projectId : null,
            code: run.problem.code,
          });
        }
      }),
    ),
  );
}

/** Refusals that describe the request rather than the Supervisor, so they are not degraded. */
const INPUT_REFUSALS: ReadonlySet<ProjectTurnRunProblemCode> = new Set([
  "invalid-prompt",
  "invalid-project-id",
  "unknown-project-id",
]);

/** A turn the store admitted, or the refusal that stopped it first. */
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
 * Admit the turn, start it, and hand its lease to the stream or give it back. Only the wait for
 * the start can be interrupted: once the start has answered, the hand-off runs whole, so the lease
 * always ends up owned by exactly one of the stream or the abandonment.
 */
function admitAndStart(input: RunProjectTurnInput): Effect.Effect<ProjectTurnRun> {
  return Effect.gen(function* () {
    const admission = yield* Effect.sync(() => admit(input));

    if (!admission.admitted) return admission.refusal;

    const { turn } = admission;

    return yield* Effect.uninterruptibleMask((restore) =>
      restore(boundedStart(input, turn, admission.request)).pipe(
        // A lost RPC rejects instead of returning a refusal. The route deliberately turns that
        // exception into `internal-error`, but this lease still belongs to this turn and must be
        // released before the exception crosses the boundary.
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

/** Give the started turn's lease to its stream, or back to the store with the reason it ended. */
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

  return { ok: true, frames: streamOrAbandon(input, turn, started.frames) };
}

/** Fix everything the rest of the turn is measured against, and log that it was admitted. */
function admittedTurn(
  input: RunProjectTurnInput,
  admitted: Extract<ProjectTurnLeaseResult, { ok: true }>,
  attribution: TurnAttribution,
  admittedAt: number,
): AdmittedTurn {
  const projectId = admitted.thread.projectId;
  const generation = attribution.active.generation?.label;
  const trace = turnTrace(projectId, admitted.leaseId, generation, admittedAt);

  logEvent("info", "turn.admitted", turnFields(trace));

  if (admitted.reclaimed === true) {
    logEvent("warn", "turn.lease-reclaimed", {
      ...turnFields(trace),
      why: "previous-instance",
    });
  }

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
  frames: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  try {
    return streamAdmittedTurn(input, turn, frames);
  } catch (error) {
    // Constructing the Supervisor-owned response stream can itself fail after the facet started.
    abandonTurn(input, turn, "stream-failed");
    throw error;
  }
}

function abandonTurn(input: RunProjectTurnInput, turn: AdmittedTurn, why: string): void {
  turn.bound.stop();
  releaseLease({ ...turn, threads: input.threads }, `turn-abandon.${why}`);
  logLeaseAbandoned(turn.trace, why, "warn");
}

/**
 * Start the turn on the serving generation, out of the turn's one budget.
 *
 * Mounting a generation, reconciling the workspace, and asking a facet to begin are all calls to
 * something that can be lost, and a lost facet answers neither yes nor no. The start therefore
 * races the turn's own bound rather than a fresh timer of its own: whatever the start spends is
 * spent out of the same budget the stream then reads from, so the turn cannot take its deadline
 * twice and cannot outlive the lease that admitted it.
 *
 * The start runs as its own fiber, which this turn joins rather than owns. Some of its steps cannot
 * be recalled once sent, such as a provisioning plan that holds the workspace exclusion until its
 * Workspace Host RPC returns, and the turn must answer at its bound rather than when those return.
 * So a start that loses the race is left to finish on its own, as a Promise would be, and is
 * cancelled, not dropped. The bound has already aborted the turn's signal, which is what stops a
 * mount or a provisioning step that has not finished; interrupting the fiber would only stop it
 * waiting, not stop the native work. A facet that answers anyway answers with a live stream, and
 * that stream is cancelled here. Without this, a generation that returned one second late would
 * go on running its tools in the tenant's one shared workspace (ADR-0038) while the project's lease
 * had already gone back and a replacement turn had been admitted to it.
 */
function boundedStart(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  request: FacetTurnHandoff,
): Effect.Effect<ProjectTurnStart | "timed-out"> {
  const context: TurnStartContext = {
    attribution: turn.attribution,
    signal: turn.bound.signal,
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
        timedEffect("turn.started", turnFields(turn.trace), startOutcome),
        // Nobody takes the start's stream if the turn stopped waiting for it: at the bound, or
        // because this program was interrupted.
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

function startOutcome(started: Result.Result<ProjectTurnStart | "timed-out">): TimedOutcome {
  if (Result.isFailure(started)) return started.failure;

  const outcome = started.success;

  if (outcome === "timed-out") return { outcome, level: "error" };

  return outcome.ok ? { outcome: "started" } : { outcome: outcome.reason, level: "warn" };
}

/** Ends the work behind a start nobody is waiting for any more. */
function cancelOrphanedStart(ended: Exit.Exit<Exit.Exit<ProjectTurnStart>>): void {
  if (Exit.isSuccess(ended) && Exit.isSuccess(ended.value) && ended.value.value.ok) {
    ended.value.value.frames.cancel().then(
      () => {},
      () => {},
    );
  }
}

/** Hand the browser the turn's stream, read and settled on the server side. */
function streamAdmittedTurn(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  frames: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return readTurnStream({
    projectId: turn.projectId,
    leaseId: turn.leaseId,
    frames,
    threads: input.threads,
    now: input.now,
    bound: turn.bound,
    trace: turn.trace,
  });
}
