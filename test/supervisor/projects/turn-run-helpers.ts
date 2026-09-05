/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test";
import { Generations } from "../../../src/supervisor/generations/index.js";
import {
  runProjectTurn,
  TurnCredits,
  type CompletedRealTurnCredit,
  type ProjectTurnRunProblemCode,
  type ProjectTurnStart,
  type RunProjectTurnInput,
} from "../../../src/supervisor/projects/index.js";
import { RelayAttempts, type RelayAttempt } from "../../../src/supervisor/relay/index.js";
import { ProjectThreads, type SerializedThread } from "../../../src/supervisor/threads/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/supervisor/supervisor.js";
import { sampleCatalog } from "../../project-fixtures.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

/**
 * One project turn, run against the real thread store, the real relay attempts, and the real
 * credit ledger of a Supervisor, with a scripted generation in place of a mounted facet.
 *
 * The generation is the only fake. Everything a turn decides — admission, the lease, the save, the
 * credit, and what the browser is told — runs here exactly as it does in a deployment, because a
 * turn's rules are about storage and not about which code produced the frames. workerd cannot run
 * a Computer container, so a real facet would refuse before any of that was reachable
 * (`supervisor-project-turn.test.ts` holds that half).
 *
 * The generation's stream is created inside the Durable Object under test. A stream belongs to
 * the object whose context created it, and one built in the test's own context cannot be read
 * from another object in the same isolate.
 */

export const NOW = 1_700_000_000_000;
export const DEADLINE_MS = 60_000;

const encoder = new TextEncoder();

/** A generation's stream a test writes into frame by frame, so a turn can be observed mid-flight. */
export interface ScriptedGeneration {
  readonly stream: ReadableStream<Uint8Array>;
  /** Write one line as it stands, so a test can send a frame no real generation would. */
  line(text: string): void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: a scripted generation writes whatever a generation could write, including frames the parse boundary must refuse.
  frame(value: unknown): void;
  close(): void;
}

function scriptedGeneration(): ScriptedGeneration {
  const state = { cancelled: false, closed: false };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      state.cancelled = true;
    },
  });

  const write = (text: string) => {
    if (!state.cancelled && !state.closed) controller?.enqueue(encoder.encode(text));
  };
  return {
    stream,
    line: (text) => {
      write(`${text}\n`);
    },
    frame: (value) => {
      write(`${JSON.stringify(value)}\n`);
    },
    close: () => {
      if (!state.cancelled && !state.closed) {
        state.closed = true;
        controller?.close();
      }
    },
  };
}

export interface TurnObservation {
  /** The refusal code, when the turn never started. */
  readonly refused: ProjectTurnRunProblemCode | undefined;
  /** Every frame the browser received, in order. */
  readonly frames: readonly unknown[];
  readonly thread: SerializedThread | undefined;
  readonly attempts: readonly RelayAttempt[];
  readonly credits: readonly CompletedRealTurnCredit[];
  /** The generation serving when the turn ended, which a mid-turn activation may have changed. */
  readonly activeLabel: number | undefined;
}

export interface TurnScript {
  readonly projectId?: unknown;
  readonly prompt?: unknown;
  /** What the generation writes, one frame per line, before the turn reads any of it. */
  readonly frames?: readonly unknown[];
  /** Raw lines, for the streams a well-behaved generation would never produce. */
  readonly lines?: readonly string[];
  /** Leave the stream open, as a lost facet or an interrupted host does. */
  readonly keepOpen?: boolean;
  /** Refuse to start the turn at all, with the reason a real refusal would carry. */
  readonly refuseStart?: ProjectTurnStart;
  /** Never answer the start call, as a lost facet or an interrupted host does. */
  readonly stallStart?: boolean;
  /** Runs inside the object before the turn is admitted, to leave a record behind. */
  readonly beforeRun?: (state: DurableObjectState) => void;
  readonly deadlineMs?: number;
  /** Stop reading after this many frames, as a browser that goes away mid-turn does. */
  readonly cancelAfter?: number;
  /** Runs inside the object once the turn is admitted and streaming. */
  readonly whileRunning?: (state: DurableObjectState, generation: ScriptedGeneration) => void;
  /** The request the generation was handed, for a test that checks what crossed. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: the handoff is observed exactly as it crossed, before the generation parses it.
  readonly handoff?: (request: unknown) => void;
}

async function readFrames(
  stream: ReadableStream<Uint8Array>,
  cancelAfter: number | undefined,
): Promise<readonly unknown[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let buffer = "";
  for (;;) {
    if (cancelAfter !== undefined && frames.length >= cancelAfter) {
      await reader.cancel();
      // The turn settles after the cancellation reaches it: the read it was waiting on ends, the
      // lease goes back, and the relay attempt is settled. None of that is the browser's to wait
      // for, so a test waits for it here instead.
      await scheduler.wait(50);
      break;
    }

    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== "") frames.push(JSON.parse(line));
    }
  }
  return frames;
}

function writeScript(generation: ScriptedGeneration, script: TurnScript): void {
  for (const frame of script.frames ?? []) generation.frame(frame);
  for (const line of script.lines ?? []) generation.line(line);
  if (script.keepOpen !== true) generation.close();
}

/**
 * Run one turn inside the Supervisor under test and report everything it left behind.
 *
 * Every observation is read after the turn settles and from the object's own storage, so a test
 * asserts what survived rather than what a return value claimed.
 */
export function runScriptedTurn(
  control: DurableObjectStub<Supervisor>,
  script: TurnScript = {},
): Promise<TurnObservation> {
  return runInDurableObject(control, async (_instance, state) => {
    const stores = turnStores(state);
    const projectId = script.projectId ?? "sample-project-one";
    const generation = scriptedGeneration();
    writeScript(generation, script);
    script.beforeRun?.(state);

    const run = await runProjectTurn(turnInput(stores, script, projectId, generation));

    script.whileRunning?.(state, generation);
    const frames = run.ok ? await readFrames(run.frames, script.cancelAfter) : [];
    return observation(stores, projectId, run.ok ? undefined : run.problem.code, frames);
  });
}

interface TurnStores {
  readonly threads: ProjectThreads;
  readonly attempts: RelayAttempts;
  readonly credits: TurnCredits;
  readonly generations: Generations;
}

function turnStores(state: DurableObjectState): TurnStores {
  return {
    threads: new ProjectThreads(state.storage, () => sampleCatalog),
    attempts: new RelayAttempts(state.storage),
    credits: new TurnCredits(state.storage),
    generations: new Generations(state.storage),
  };
}

function turnInput(
  stores: TurnStores,
  script: TurnScript,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: a test may name a project the catalog will refuse.
  projectId: unknown,
  generation: ScriptedGeneration,
): RunProjectTurnInput {
  return {
    projectId,
    prompt: script.prompt ?? "do the work",
    threads: stores.threads,
    attempts: stores.attempts,
    credits: stores.credits,
    attribution: () => {
      const active = stores.generations.active();
      return {
        active,
        preparationCheckId: active.generation
          ? stores.generations.latestPreparationCheck(active.generation.label)?.id
          : undefined,
      };
    },
    start: (_project, request) => {
      script.handoff?.(request);
      if (script.stallStart === true) {
        return new Promise<ProjectTurnStart>(() => {});
      }
      return Promise.resolve(script.refuseStart ?? { ok: true, frames: generation.stream });
    },
    now: () => NOW,
    leaseMs: PROJECT_TURN_LEASE_MS,
    deadlineMs: script.deadlineMs ?? DEADLINE_MS,
  };
}

function observation(
  stores: TurnStores,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the surface: see `turnInput`.
  projectId: unknown,
  refused: ProjectTurnRunProblemCode | undefined,
  frames: readonly unknown[],
): TurnObservation {
  const thread = stores.threads.read(projectId);
  return {
    refused,
    frames,
    thread: thread.ok ? thread.thread : undefined,
    attempts: stores.attempts.all(),
    credits: stores.credits.all(),
    activeLabel: stores.generations.active().generation?.label,
  };
}
