// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The project id and the prompt arrive from a client through the Worker, so neither has a proven shape until this module proves it.

import { parseThreadMessages } from "../threads/index.js";
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
  start: (projectId: string, request: FacetTurnHandoff) => Promise<ProjectTurnStart>;
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

/**
 * One authenticated project turn, from admission to the stream the browser reads.
 *
 * The order is what makes the turn the server's. The prompt is validated first, because a request
 * that is not a turn should not take a lease. The thread is read next and its revision is the one
 * the admission presents, so a client cannot choose which revision it is admitted at. The lease
 * follows, and the id it mints stays here: no response carries it, so nothing outside this
 * Supervisor can finish or abandon this turn. The generation attribution is snapshotted at that
 * moment, so an activation during the turn cannot relabel its evidence. Only then does the work
 * start, and the saved conversation reaches the generation as history the server holds rather
 * than as trusted history a request supplied.
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

  const admitted = input.threads.startTurn(
    input.projectId,
    current.thread.revision,
    input.now(),
    input.leaseMs,
  );
  if (!admitted.ok) {
    return refused(admitted.problem.code);
  }

  const projectId = admitted.thread.projectId;
  const started = await boundedStart(input, projectId, { prompt, messages: history.value });
  if (started === "timed-out") {
    input.threads.abandonTurn(projectId, admitted.leaseId);
    return recordAbandonedStart(input);
  }
  if (!started.ok) {
    input.threads.abandonTurn(projectId, admitted.leaseId);
    return recordUnstartedTurn(input, started.reason);
  }

  return {
    ok: true,
    frames: streamAdmittedTurn(input, projectId, admitted.leaseId, started.frames),
  };
}

/**
 * Start the turn on the serving generation, under the same bound the running turn gets.
 *
 * Mounting a generation, reconciling the workspace, and asking a facet to begin are all calls to
 * something that can be lost, and a lost facet answers neither yes nor no. Without this bound the
 * project would hold its lease until the lease itself expired, with a browser waiting on a stream
 * no one will ever write to. The turn is abandoned instead, and the next admission finds the slot
 * free.
 */
function boundedStart(
  input: RunProjectTurnInput,
  projectId: string,
  request: FacetTurnHandoff,
): Promise<ProjectTurnStart | "timed-out"> {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => {
    expiry = setTimeout(() => {
      resolve("timed-out");
    }, input.deadlineMs);
  });

  return Promise.race([input.start(projectId, request), bound]).finally(() => {
    clearTimeout(expiry);
  });
}

/**
 * Record the running turn as a relay attempt and hand the browser its stream.
 *
 * The attempt is opened only once a generation has actually begun the turn, and its status is set
 * to the 200 this response will carry, so the row describes what the client sees. Its generation
 * attribution is snapshotted here and never re-read: an activation during the turn changes what
 * the next turn runs on, not what this one is evidence about.
 */
function streamAdmittedTurn(
  input: RunProjectTurnInput,
  projectId: string,
  leaseId: string,
  frames: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const attribution = input.attribution();
  const attempt = input.attempts.start(
    attribution.active,
    attribution.preparationCheckId,
    input.now(),
    input.deadlineMs,
  );
  input.attempts.headersReceived(attempt.id, 200);

  return projectTurnStream({
    projectId,
    leaseId,
    attempt,
    frames,
    threads: input.threads,
    attempts: input.attempts,
    credits: input.credits,
    now: input.now,
    deadlineMs: input.deadlineMs,
  });
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
  reason: ProjectTurnRefusal,
): ProjectTurnRun {
  if (reason === "no-active-generation") {
    return refused(reason);
  }

  return recordUnstarted(input, "pre-header-failure", reason);
}

/**
 * A start that ran out of time. It is a bounded abandonment rather than a failure, for ADR-0031's
 * reason: nothing was observed, so the record earns the generation neither credit nor blame. The
 * client is told the turn did not start, which is all that is known about it.
 */
function recordAbandonedStart(input: RunProjectTurnInput): ProjectTurnRun {
  return recordUnstarted(input, "bounded-abandonment", "turn-not-started");
}

function recordUnstarted(
  input: RunProjectTurnInput,
  outcome: "pre-header-failure" | "bounded-abandonment",
  reason: ProjectTurnRefusal,
): ProjectTurnRun {
  const attribution = input.attribution();
  const attempt = input.attempts.start(
    attribution.active,
    attribution.preparationCheckId,
    input.now(),
    input.deadlineMs,
  );
  input.attempts.settle(attempt.id, outcome, input.now());
  return refused(reason);
}
