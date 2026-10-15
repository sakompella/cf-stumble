/// <reference types="@cloudflare/vitest-plugin/types" />

// oxlint-disable max-lines, import/max-dependencies -- One file holds every lifetime rule of a turn, so the rules can be read side by side, against the real thread store.

import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseProjectId } from "../../../src/project-catalog.js";
import { Generations } from "../../../src/supervisor/generations/index.js";
import { ProjectThreads, type ProjectThreadResult } from "../../../src/supervisor/threads/index.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/turn-budget.js";
import { capturedEvents } from "../../log-capture.js";
import { sampleSelectableCatalog } from "../../project-fixtures.js";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../threads/message-samples.js";
import { idleWorkspace } from "./turn-workspace-fakes.js";
import {
  admitTurn,
  runScriptedTurn,
  scriptedGeneration,
  type ScriptedGeneration,
  type TurnScript,
} from "./turn-run-helpers.js";
import {
  runProjectTurn,
  type ProjectTurnStart,
  type RunProjectTurnInput,
  type TurnStartContext,
} from "../../../src/supervisor/projects/index.js";
import type { ProjectTurnFrame } from "../../../src/supervisor/projects/turn-frames.js";

/**
 * How long a turn lives, and what it gives back when it ends.
 *
 * The Supervisor's answer to `runProjectTurn` returns before the turn does: it carries a stream
 * whose body is still being produced (ADR-0037). These tests hold the rules that tie the turn's
 * lease, its deadline, and the generation's work to that body rather than to the answer: the body
 * keeps streaming after the answer, a browser that cancels it reaches the generation and frees the
 * project, the browser hears `saved` only once the thread write has returned, one deadline covers
 * the start and the stream together, and a turn never gives back a lease it no longer holds.
 */

const PROJECT = "sample-project-one";

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];

const completed = { kind: "completed", state: { messages: conversation } };

const decoder = new TextDecoder();

beforeEach(() => {
  capturedEvents();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

type Threads = RunProjectTurnInput["threads"];

function threadsIn(state: DurableObjectState, holderId?: string): ProjectThreads {
  return new ProjectThreads(state.storage, () => sampleSelectableCatalog, holderId);
}

function turnInput(
  state: DurableObjectState,
  threads: Threads,
  start: RunProjectTurnInput["start"],
  overrides: Partial<Pick<RunProjectTurnInput, "deadlineMs" | "leaseMs">> = {},
): RunProjectTurnInput {
  const generations = new Generations(state.storage);

  return {
    projectId: PROJECT,
    prompt: "do the work",
    threads,
    resetting: () => false,
    attribution: () => ({ active: generations.active() }),
    start,
    now: () => Date.now(),
    leaseMs: overrides.leaseMs ?? PROJECT_TURN_LEASE_MS,
    deadlineMs: overrides.deadlineMs ?? 60_000,
  };
}

function startingWith(generation: ScriptedGeneration): RunProjectTurnInput["start"] {
  return () => Effect.succeed({ ok: true, frames: generation.stream, workspace: idleWorkspace });
}

function frameOf(chunk: ReadableStreamReadResult<Uint8Array>): ProjectTurnFrame | undefined {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the Supervisor writes one ProjectTurnFrame per chunk, and every assertion compares the frame whole.
  return chunk.done ? undefined : (JSON.parse(decoder.decode(chunk.value)) as ProjectTurnFrame);
}

async function framesOf(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const reader = stream.getReader();
  const frames: unknown[] = [];

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) return frames;

    frames.push(frameOf(chunk));
  }
}

function turnActive(threads: ProjectThreads): boolean | undefined {
  const read = threads.read(PROJECT);

  return read.ok ? read.thread.turnActive : undefined;
}

function revision(threads: ProjectThreads): number | undefined {
  const read = threads.read(PROJECT);

  return read.ok ? read.thread.revision : undefined;
}

/** A start that answers with `generation` after `delayMs`, as a slow mount or facet does. */
function startingLate(
  generation: ScriptedGeneration,
  delayMs: number,
  seen?: (context: TurnStartContext) => void,
): RunProjectTurnInput["start"] {
  return (_project, _request, context) => {
    seen?.(context);

    return Effect.promise(() => scheduler.wait(delayMs)).pipe(
      Effect.as({
        ok: true,
        frames: generation.stream,
        workspace: idleWorkspace,
      } satisfies ProjectTurnStart),
    );
  };
}

test("the body keeps streaming after the turn's answer has returned", async () => {
  const control = await supervisor("turn-lifetime-body-outlives-answer");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    const run = await admitTurn(turnInput(state, threads, startingWith(generation)));

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    // The answer has returned. Nothing has been written yet, and the turn must still be running.
    await scheduler.wait(20);
    const afterAnswer = { held: turnActive(threads), cancelled: generation.cancelled() };

    const reader = run.frames.getReader();
    generation.frame({ kind: "text", text: "written after the answer" });
    const text = frameOf(await reader.read());
    generation.frame(completed);
    const saved = frameOf(await reader.read());
    const storedWhenSavedArrived = revision(threads);
    const end = await reader.read();

    return {
      afterAnswer,
      text,
      saved,
      storedWhenSavedArrived,
      ended: end.done,
      held: turnActive(threads),
      generationCancelled: generation.cancelled(),
    };
  });

  expect(observed.afterAnswer).toEqual({ held: true, cancelled: false });
  expect(observed.text).toEqual({ kind: "text", text: "written after the answer" });
  expect(observed.saved).toEqual({ kind: "saved", revision: 1, messageCount: conversation.length });
  expect(observed.storedWhenSavedArrived).toBe(1);
  expect(observed.ended).toBe(true);
  expect(observed.held).toBe(false);
  // The read stops at the terminal frame and cancels the rest, so a generation that goes quiet
  // after saying how the turn ended cannot hold anything open.
  expect(observed.generationCancelled).toBe(true);
});

test("a browser that cancels reaches the generation and gives the project back", async () => {
  const control = await supervisor("turn-lifetime-cancel-reaches-generation");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    let signal: AbortSignal | undefined;

    const run = await admitTurn(
      turnInput(state, threads, (_project, _request, context) => {
        signal = context.signal;

        return Effect.succeed({ ok: true, frames: generation.stream, workspace: idleWorkspace });
      }),
    );

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    const reader = run.frames.getReader();
    generation.frame({ kind: "text", text: "working" });
    await reader.read();
    const heldWhileStreaming = turnActive(threads);
    await reader.cancel();
    await scheduler.wait(20);

    return {
      heldWhileStreaming,
      generationCancelled: generation.cancelled(),
      signalAborted: signal?.aborted,
      held: turnActive(threads),
      revision: revision(threads),
    };
  });

  expect(observed).toEqual({
    heldWhileStreaming: true,
    generationCancelled: true,
    signalAborted: true,
    held: false,
    revision: 0,
  });

  // The project is free at once, not at the cancelled turn's deadline.
  const next = await runScriptedTurn(control, { frames: [completed] });

  expect(next.frames.at(-1)).toMatchObject({ kind: "saved", revision: 1 });
});

test("a browser that cancels before reading anything still ends the turn", async () => {
  const control = await supervisor("turn-lifetime-cancel-unread");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    const run = await admitTurn(turnInput(state, threads, startingWith(generation)));

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    await run.frames.cancel();
    await scheduler.wait(20);

    return { generationCancelled: generation.cancelled(), held: turnActive(threads) };
  });

  expect(observed).toEqual({ generationCancelled: true, held: false });
});

/**
 * Every way a turn can end gives the project back: the thread is idle afterwards and the next turn
 * is admitted at once, without waiting for the ended turn's lease or deadline.
 */
const endings: readonly (readonly [string, TurnScript, "refused" | "rejects" | "streams"])[] = [
  ["a completed turn", { frames: [completed] }, "streams"],
  [
    "a failed turn",
    { frames: [{ kind: "failed", code: "model-error", state: { messages: conversation } }] },
    "streams",
  ],
  ["a rejected turn", { frames: [{ kind: "rejected", code: "invalid-turn-request" }] }, "streams"],
  ["a malformed stream", { lines: ["{not json"] }, "streams"],
  ["a stream with no terminal frame", { frames: [] }, "streams"],
  [
    "a browser that went away",
    { frames: [{ kind: "text", text: "working" }], keepOpen: true, cancelAfter: 1 },
    "streams",
  ],
  [
    "a turn that reached its deadline",
    { frames: [{ kind: "text", text: "working" }], keepOpen: true, deadlineMs: 25 },
    "streams",
  ],
  ["a refused start", { refuseStart: { ok: false, reason: "workspace-unavailable" } }, "refused"],
  ["a start that never answered", { stallStart: true, deadlineMs: 25 }, "refused"],
  ["a start that threw", { throwStart: true }, "rejects"],
  ["a stream whose reader could not be made", { throwStreamReader: true }, "rejects"],
];

test.for(endings)("%s gives the lease back at once", async ([name, script, expected]) => {
  const control = await supervisor(`turn-lifetime-ending-${name.replaceAll(" ", "-")}`);
  await activateFixtureGeneration(control);

  if (expected === "rejects") {
    await expect(runScriptedTurn(control, script)).rejects.toThrow();
  } else {
    const ended = await runScriptedTurn(control, script);

    expect(ended.refused !== undefined).toBe(expected === "refused");
    expect(ended.thread).toMatchObject({ turnActive: false });
  }

  const before = await control.getProjectThread(PROJECT);
  const next = await runScriptedTurn(control, { frames: [completed] });

  expect(before).toMatchObject({ ok: true, thread: { turnActive: false } });
  expect(next.frames.at(-1)).toMatchObject({ kind: "saved" });
});

test("a turn from a replaced instance that ends late cannot free the replacement's lease", async () => {
  const control = await supervisor("turn-lifetime-replaced-instance-cancel");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const before = threadsIn(state, "instance-a");
    const after = threadsIn(state, "instance-b");
    const old = scriptedGeneration();
    const replacement = scriptedGeneration();

    const oldRun = await admitTurn(turnInput(state, before, startingWith(old)));
    const newRun = await admitTurn(turnInput(state, after, startingWith(replacement)));

    if (!oldRun.ok || !newRun.ok) throw new Error("both turns must start");

    // The old instance's browser goes away after the replacement was admitted. Its release
    // presents the old lease id, which the store no longer holds.
    await oldRun.frames.cancel();
    await scheduler.wait(20);
    const heldAfterOldEnded = turnActive(after);

    replacement.frame(completed);
    const replacementFrames = await framesOf(newRun.frames);

    return {
      oldCancelled: old.cancelled(),
      heldAfterOldEnded,
      replacementFrames,
      held: turnActive(after),
    };
  });

  expect(observed.oldCancelled).toBe(true);
  expect(observed.heldAfterOldEnded).toBe(true);
  expect(observed.replacementFrames).toEqual([
    { kind: "saved", revision: 1, messageCount: conversation.length },
  ]);
  expect(observed.held).toBe(false);
});

test("a replaced instance's late terminal frame saves nothing over the replacement", async () => {
  const control = await supervisor("turn-lifetime-replaced-instance-save");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const before = threadsIn(state, "instance-a");
    const after = threadsIn(state, "instance-b");
    const old = scriptedGeneration();
    const replacement = scriptedGeneration();

    const oldRun = await admitTurn(turnInput(state, before, startingWith(old)));
    const newRun = await admitTurn(turnInput(state, after, startingWith(replacement)));

    if (!oldRun.ok || !newRun.ok) throw new Error("both turns must start");

    old.frame(completed);
    const oldFrames = await framesOf(oldRun.frames);
    const heldAfterOldEnded = turnActive(after);

    replacement.frame({ kind: "text", text: "still mine" });
    replacement.frame(completed);

    return {
      oldFrames,
      heldAfterOldEnded,
      revisionAfterOld: revision(after),
      replacementFrames: await framesOf(newRun.frames),
    };
  });

  expect(observed.oldFrames).toEqual([{ kind: "save-failed", code: "turn-lease-lost" }]);
  expect(observed.heldAfterOldEnded).toBe(true);
  expect(observed.revisionAfterOld).toBe(0);
  expect(observed.replacementFrames.at(-1)).toMatchObject({ kind: "saved", revision: 1 });
});

/** The thread surface of `threads`, with `finishTurn` replaced. */
function withFinish(threads: ProjectThreads, finishTurn: Threads["finishTurn"]): Threads {
  return {
    read: (projectId) => threads.read(projectId),
    startTurn: (projectId, expectedRevision, now, leaseMs) =>
      threads.startTurn(projectId, expectedRevision, now, leaseMs),
    finishTurn,
    abandonTurn: (projectId, leaseId) => threads.abandonTurn(projectId, leaseId),
  };
}

test("a save that throws sends no saved frame and still gives the lease back", async () => {
  const control = await supervisor("turn-lifetime-save-throws");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();

    const failing = withFinish(threads, () => {
      throw new Error("storage refused the save");
    });

    const run = await admitTurn(turnInput(state, failing, startingWith(generation)));

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    generation.frame({ kind: "text", text: "done" });
    generation.frame(completed);
    const reader = run.frames.getReader();
    const frames: unknown[] = [];
    let failure: unknown;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;
        frames.push(frameOf(chunk));
      }
    } catch (error) {
      failure = error;
    }

    return {
      frames,
      failure: String(failure),
      held: turnActive(threads),
      revision: revision(threads),
    };
  });

  expect(observed.frames).toEqual([{ kind: "text", text: "done" }]);
  expect(observed.failure).toContain("storage refused the save");
  expect(observed.held).toBe(false);
  expect(observed.revision).toBe(0);
});

test("a save the store refuses is save-failed, never saved", async () => {
  const control = await supervisor("turn-lifetime-save-refused");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    const order: string[] = [];

    const projectId = parseProjectId(PROJECT);

    if (projectId === undefined) throw new Error("expected a valid project id");

    const refusing = withFinish(threads, (): ProjectThreadResult => {
      order.push("write");

      return { ok: false, problem: { code: "turn-not-active", projectId } };
    });

    const run = await admitTurn(turnInput(state, refusing, startingWith(generation)));

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    generation.frame(completed);
    const frames = await framesOf(run.frames);

    return { frames, order, held: turnActive(threads) };
  });

  expect(observed.order).toEqual(["write"]);
  expect(observed.frames).toEqual([{ kind: "save-failed", code: "turn-not-active" }]);
  expect(observed.held).toBe(false);
});

test("the start and the stream spend one deadline, measured from admission", async () => {
  const control = await supervisor("turn-lifetime-one-deadline");
  await activateFixtureGeneration(control);

  // The start takes most of the budget. If the stream were given a fresh budget of its own, the
  // turn would run for about 850 ms; with one budget it ends at about 500 ms.
  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    const admittedAt = Date.now();

    const run = await admitTurn(
      turnInput(state, threads, startingLate(generation, 350), { deadlineMs: 500 }),
    );

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    const frames = await framesOf(run.frames);

    return { frames, elapsedMs: Date.now() - admittedAt, held: turnActive(threads) };
  });

  expect(observed.frames).toEqual([{ kind: "timed-out" }]);
  expect(observed.elapsedMs).toBeGreaterThanOrEqual(450);
  expect(observed.elapsedMs).toBeLessThan(750);
  expect(observed.held).toBe(false);
});

test("a turn may not outlive its lease, whatever the deadline says", async () => {
  const control = await supervisor("turn-lifetime-lease-clamps");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    const admittedAt = Date.now();

    const run = await admitTurn(
      turnInput(state, threads, startingWith(generation), { leaseMs: 100, deadlineMs: 60_000 }),
    );

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    const frames = await framesOf(run.frames);

    return {
      frames,
      elapsedMs: Date.now() - admittedAt,
      generationCancelled: generation.cancelled(),
    };
  });

  expect(observed.frames).toEqual([{ kind: "timed-out" }]);
  expect(observed.elapsedMs).toBeLessThan(2_000);
  expect(observed.generationCancelled).toBe(true);
});

test("a start that answers after the deadline has its stream cancelled", async () => {
  const control = await supervisor("turn-lifetime-late-start");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    let signal: AbortSignal | undefined;

    const run = await admitTurn(
      turnInput(
        state,
        threads,
        startingLate(generation, 100, (context) => {
          signal = context.signal;
        }),
        { deadlineMs: 25 },
      ),
    );

    const heldAfterRefusal = turnActive(threads);
    const abortedAtRefusal = signal?.aborted;
    const cancelledAtRefusal = generation.cancelled();
    await scheduler.wait(200);

    return {
      refused: run.ok ? undefined : run.problem.code,
      heldAfterRefusal,
      abortedAtRefusal,
      cancelledAtRefusal,
      cancelledLater: generation.cancelled(),
    };
  });

  expect(observed).toEqual({
    refused: "turn-not-started",
    heldAfterRefusal: false,
    abortedAtRefusal: true,
    // The refusal does not wait for the late start: it answers at the deadline.
    cancelledAtRefusal: false,
    cancelledLater: true,
  });
});

test("the turn's signal is aborted once the turn has settled", async () => {
  const control = await supervisor("turn-lifetime-signal-after-save");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();
    let signal: AbortSignal | undefined;

    const run = await admitTurn(
      turnInput(state, threads, (_project, _request, context) => {
        signal = context.signal;

        return Effect.succeed({ ok: true, frames: generation.stream, workspace: idleWorkspace });
      }),
    );

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    const abortedWhileStreaming = signal?.aborted;
    generation.frame(completed);
    const frames = await framesOf(run.frames);

    return { abortedWhileStreaming, frames, abortedAfter: signal?.aborted };
  });

  expect(observed.abortedWhileStreaming).toBe(false);
  expect(observed.frames.at(-1)).toMatchObject({ kind: "saved" });
  expect(observed.abortedAfter).toBe(true);
});

test("a terminal frame read before the deadline stands, however long the cancel takes", async () => {
  const control = await supervisor("turn-lifetime-slow-cancel");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const encoder = new TextEncoder();

    // The generation answers with its terminal frame at once, but acknowledges the cancel that
    // follows it only after the deadline has passed, as a slow RPC stream can.
    const frames = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(completed)}\n`));
      },
      cancel: () => scheduler.wait(150),
    });

    const run = await admitTurn(
      turnInput(
        state,
        threads,
        () => Effect.succeed({ ok: true, frames, workspace: idleWorkspace }),
        { deadlineMs: 50 },
      ),
    );

    if (!run.ok) throw new Error(`the turn must start; it was refused with ${run.problem.code}`);

    return { frames: await framesOf(run.frames), revision: revision(threads) };
  });

  expect(observed.frames).toEqual([
    { kind: "saved", revision: 1, messageCount: conversation.length },
  ]);
  expect(observed.revision).toBe(1);
});

test("a turn interrupted while its start runs gives the lease back and cancels the late stream", async () => {
  const control = await supervisor("turn-lifetime-interrupted-start");
  await activateFixtureGeneration(control);

  const observed = await runInDurableObject(control, async (_instance, state) => {
    const threads = threadsIn(state);
    const generation = scriptedGeneration();

    const running = Effect.runFork(
      runProjectTurn(turnInput(state, threads, startingLate(generation, 50))),
    );

    await scheduler.wait(10);
    const heldWhileStarting = turnActive(threads);
    await Effect.runPromise(Fiber.interrupt(running));
    const heldAfterInterrupt = turnActive(threads);
    await scheduler.wait(100);

    return { heldWhileStarting, heldAfterInterrupt, cancelled: generation.cancelled() };
  });

  expect(observed).toEqual({ heldWhileStarting: true, heldAfterInterrupt: false, cancelled: true });
});
