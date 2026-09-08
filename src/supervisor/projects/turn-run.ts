// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The project id and the prompt arrive from a client through the Worker, so neither has a proven shape until this module proves it.

import { parseThreadMessages } from "../threads/index.js";
import { TurnBound } from "./turn-bound.js";
import { projectTurnStream } from "./turn-stream.js";
import type { TurnAttemptRecord, TurnCreditLedger, TurnThreadWrites } from "./turn-settle.js";
import type { ActiveGeneration } from "../generations/index.js";
import type { RelayAttempt } from "../relay/index.js";
import type {
  ProjectThreadProblem,
  ProjectThreadResult,
  ProjectTurnLeaseResult,
} from "../threads/index.js";
import type { ProjectTurnRefusal, ProjectTurnStart } from "./project-turn.js";

/** The longest prompt one turn accepts. Longer input is a refused request, not a truncated one. */
export const PROJECT_TURN_PROMPT_MAX_LENGTH = 32_000;

/**
 * The thread surface one turn drives: admission here, and the two writes the running turn makes.
 * `ProjectThreads` satisfies it, and the read and the admission take the client's project id so
 * the catalog resolves it there rather than here.
 */
export type TurnThreads = TurnThreadWrites &
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
}>;

/** Where a turn is recorded as a relay attempt (ADR-0031), with the generation it ran on. */
export type TurnAttempts = TurnAttemptRecord &
  Readonly<{
    start(
      active: ActiveGeneration,
      preparationCheckId: number | undefined,
      startedAt: number,
      deadlineMs: number,
    ): RelayAttempt;
    headersReceived(attemptId: number, responseStatus: number): void;
    /** Settle every attempt whose bound has passed. Admission is where this Supervisor runs it. */
    sweepExpired(now: number): readonly RelayAttempt[];
  }>;

/** The generation a turn is attributed to, read once at admission and never re-read. */
export type TurnAttribution = Readonly<{
  active: ActiveGeneration;
  preparationCheckId: number | undefined;
}>;

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
  attempts: TurnAttempts;
  credits: TurnCreditLedger;
  attribution: () => TurnAttribution;
  /** Runs the turn on the serving generation. The Supervisor binds the workspace and mount. */
  start: (
    projectId: string,
    request: FacetTurnHandoff,
    context: TurnStartContext,
  ) => Promise<ProjectTurnStart>;
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
  /** The generation the turn runs on and is recorded against. */
  attribution: TurnAttribution;
  /** The instant the turn ends, and the cancellation every step of it honours. */
  bound: TurnBound;
}>;

/**
 * One authenticated project turn, from admission to the stream the browser reads.
 *
 * The order is what makes the turn the server's. The prompt is validated first, because a request
 * that is not a turn should not take a lease. The thread is read next and its revision is the one
 * the admission presents, so a client cannot choose which revision it is admitted at. The lease
 * follows, and the id it mints stays here: no response carries it, so nothing outside this
 * Supervisor can finish or abandon this turn. Admission also fixes the two things the rest of the
 * turn is measured against: the instant the turn ends ({@link TurnBound}) and the generation it is
 * evidence about, both read once here and never read again. Only then does the work start, and the
 * saved conversation reaches the generation as history the server holds rather than as trusted
 * history a request supplied.
 */
export async function runProjectTurn(input: RunProjectTurnInput): Promise<ProjectTurnRun> {
  const prompt = parsePrompt(input.prompt);
  if (prompt === undefined) {
    return refused("invalid-prompt");
  }

  // Evidence a previous turn could not settle itself, reconciled on the request path that is
  // already here. A Supervisor evicted mid-turn leaves its attempt pending, and ADR-0031 bounds an
  // unresolved attempt by an explicit sweep rather than by an alarm. Bounded abandonment earns
  // neither credit nor blame, so this reconciles a record without judging a generation.
  input.attempts.sweepExpired(input.now());

  const current = input.threads.read(input.projectId);
  if (!current.ok) {
    return refused(current.problem.code);
  }
  const history = parseThreadMessages(current.thread.conversation);
  if (history.isErr()) {
    return refused("unreadable-thread");
  }

  const admittedAt = input.now();
  const admitted = input.threads.startTurn(
    input.projectId,
    current.thread.revision,
    admittedAt,
    input.leaseMs,
  );
  if (!admitted.ok) {
    return refused(admitted.problem.code);
  }

  const turn: AdmittedTurn = {
    projectId: admitted.thread.projectId,
    leaseId: admitted.leaseId,
    attribution: input.attribution(),
    bound: TurnBound.forTurn(admittedAt, input.leaseMs, input.deadlineMs, input.now),
  };

  const started = await boundedStart(input, turn, { prompt, messages: history.value });
  if (started === "timed-out") {
    input.threads.abandonTurn(turn.projectId, turn.leaseId);
    return recordAbandonedStart(input, turn);
  }
  if (!started.ok) {
    turn.bound.stop();
    input.threads.abandonTurn(turn.projectId, turn.leaseId);
    return recordUnstartedTurn(input, turn, started.reason);
  }

  return { ok: true, frames: streamAdmittedTurn(input, turn, started.frames) };
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
 * A start that loses that race is cancelled, not dropped. The bound has already aborted the
 * turn's signal, which is what stops a mount or a provisioning step that has not finished; a
 * facet that answers anyway answers with a live stream, and that stream is cancelled here. Without
 * this, a generation that returned one second late would go on running its tools in the tenant's
 * one shared workspace (ADR-0038) while the project's lease had already gone back and a
 * replacement turn had been admitted to it.
 */
async function boundedStart(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  request: FacetTurnHandoff,
): Promise<ProjectTurnStart | "timed-out"> {
  const context: TurnStartContext = { attribution: turn.attribution, signal: turn.bound.signal };
  const started = input.start(turn.projectId, request, context);
  const outcome = await Promise.race([started, turn.bound.whenTimedOut()]);
  if (outcome !== "timed-out") {
    return outcome;
  }

  started.then(cancelOrphanedStart, () => {
    // A start that failed after the bound left nothing running to cancel.
  });
  return "timed-out";
}

/** Ends the work behind a start nobody is waiting for any more. */
function cancelOrphanedStart(started: ProjectTurnStart): void {
  if (started.ok) {
    started.frames.cancel().then(
      () => {},
      () => {},
    );
  }
}

/**
 * Record the running turn as a relay attempt and hand the browser its stream.
 *
 * The attempt is opened only once a generation has actually begun the turn, and its status is set
 * to the 200 this response will carry, so the row describes what the client sees. It is recorded
 * against the generation admission snapshotted, which is the generation that was mounted to serve
 * it: an activation during the mount, the provisioning, or the facet start changes what the next
 * turn runs on, not what this one is evidence about. Its bound is the turn's own, so the attempt
 * expires when the turn does rather than a deadline later.
 */
function streamAdmittedTurn(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  frames: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const attempt = openAttempt(input, turn);
  input.attempts.headersReceived(attempt.id, 200);

  return projectTurnStream({
    projectId: turn.projectId,
    leaseId: turn.leaseId,
    attempt,
    frames,
    threads: input.threads,
    attempts: input.attempts,
    credits: input.credits,
    now: input.now,
    bound: turn.bound,
  });
}

/** One relay attempt for one turn, attributed and bounded by what admission decided. */
function openAttempt(input: RunProjectTurnInput, turn: AdmittedTurn): RelayAttempt {
  const now = input.now();
  return input.attempts.start(
    turn.attribution.active,
    turn.attribution.preparationCheckId,
    now,
    turn.bound.endsAt - now,
  );
}

/**
 * A turn that never started, as evidence about the generation.
 *
 * `no-active-generation` records nothing, for ADR-0031's reason: there is no generation for the
 * observation to be about. Every other refusal happened while a generation was serving and is a
 * failure it must answer for, which is the same rule `relay/index.ts` applies to a mount failure.
 */
function recordUnstartedTurn(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  reason: ProjectTurnRefusal,
): ProjectTurnRun {
  if (reason === "no-active-generation") {
    return refused(reason);
  }

  return recordUnstarted(input, turn, "pre-header-failure", reason);
}

/**
 * A start that ran out of time. It is a bounded abandonment rather than a failure, for ADR-0031's
 * reason: nothing was observed, so the record earns the generation neither credit nor blame. The
 * client is told the turn did not start, which is all that is known about it.
 */
function recordAbandonedStart(input: RunProjectTurnInput, turn: AdmittedTurn): ProjectTurnRun {
  return recordUnstarted(input, turn, "bounded-abandonment", "turn-not-started");
}

function recordUnstarted(
  input: RunProjectTurnInput,
  turn: AdmittedTurn,
  outcome: "pre-header-failure" | "bounded-abandonment",
  reason: ProjectTurnRefusal,
): ProjectTurnRun {
  const attempt = openAttempt(input, turn);
  input.attempts.settle(attempt.id, outcome, input.now());
  return refused(reason);
}
