import { expect, test, vi } from "vitest";
import { capturedEvents, named } from "../../log-capture.js";
import { TurnBound } from "../../../src/supervisor/projects/turn-bound.js";
import { readTurnStream } from "../../../src/supervisor/projects/turn-stream.js";
import { turnTrace } from "../../../src/supervisor/projects/turn-log.js";
import { idleWorkspace } from "./turn-workspace-fakes.js";
import { parseProjectId } from "../../../src/project-catalog.js";
import type { ProjectThreadResult } from "../../../src/supervisor/threads/index.js";

const now = () => Date.now();

class RejectingReader {
  #reject: ((reason: Error) => void) | undefined;

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((_resolve, reject) => {
      this.#reject = reject;
    });
  }

  cancel(): Promise<void> {
    this.#reject?.(new Error("RPC stream cancelled"));

    return Promise.resolve();
  }
}

function rejectingFrames(reader: RejectingReader): ReadableStream<Uint8Array> {
  const frames = new ReadableStream<Uint8Array>();
  Object.defineProperty(frames, "getReader", { value: () => reader });

  return frames;
}

test("a stream that cannot create a reader abandons its lease", async () => {
  const frames = new ReadableStream<Uint8Array>();
  Object.defineProperty(frames, "getReader", {
    value: () => {
      throw new Error("stream reader unavailable");
    },
  });
  const projectId = parseProjectId("project-one");

  if (projectId === undefined) throw new Error("expected a valid project id");

  const abandonTurn = vi.fn((_projectId: string, _leaseId: string): ProjectThreadResult => ({
    ok: false,
    problem: { code: "turn-not-active", projectId },
  }));

  const bound = new TurnBound(Date.now() + 1_000, now);

  const stream = readTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: { finishTurn: vi.fn(), abandonTurn },
    now,
    bound,
    workspace: idleWorkspace,
    trace: turnTrace(projectId, "lease-one", undefined, Date.now()),
    frames,
  });

  await expect(stream.getReader().read()).rejects.toThrow("stream reader unavailable");
  expect(abandonTurn).toHaveBeenCalledOnce();
  bound.stop();
});

test("a deadline that rejects the pending RPC read is timed out", async () => {
  const reader = new RejectingReader();
  const projectId = parseProjectId("project-one");

  if (projectId === undefined) throw new Error("expected a valid project id");

  const abandonTurn = vi.fn((_projectId: string, _leaseId: string): ProjectThreadResult => ({
    ok: false,
    problem: { code: "turn-not-active", projectId },
  }));

  const finishTurn = vi.fn();
  const bound = new TurnBound(Date.now() + 10, now);

  const stream = readTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: { finishTurn, abandonTurn },
    now,
    bound,
    workspace: idleWorkspace,
    trace: turnTrace(projectId, "lease-one", undefined, Date.now()),
    frames: rejectingFrames(reader),
  });

  const output = stream.getReader();

  const result = await output.read();

  expect(result.done).toBe(false);
  expect(JSON.parse(new TextDecoder().decode(result.value))).toEqual({ kind: "timed-out" });
  expect(abandonTurn).toHaveBeenCalledOnce();
  expect(finishTurn).not.toHaveBeenCalled();
});

test("a failed lease cleanup does not replace the stream failure", async () => {
  const events = capturedEvents();
  const frames = new ReadableStream<Uint8Array>();
  Object.defineProperty(frames, "getReader", {
    value: () => {
      throw new Error("stream reader unavailable");
    },
  });
  const projectId = parseProjectId("project-one");

  if (projectId === undefined) throw new Error("expected a valid project id");

  const bound = new TurnBound(Date.now() + 1_000, now);

  const stream = readTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: {
      finishTurn: vi.fn(),
      abandonTurn: () => {
        throw new Error("storage connection closed");
      },
    },
    now,
    bound,
    workspace: idleWorkspace,
    trace: turnTrace(projectId, "lease-one", undefined, Date.now()),
    frames,
  });

  await expect(stream.getReader().read()).rejects.toThrow("stream reader unavailable");
  expect(named(events(), "turn.lease-abandoned")).toHaveLength(1);
  bound.stop();
});

const decoder = new TextDecoder();

/** A generation that writes nothing for `quietMs`, then `lines`, then closes. */
function quietFrames(quietMs: number, lines: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await scheduler.wait(quietMs);

      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
}

/** A turn read to its end: each chunk the Supervisor wrote, and when the stream closed. */
async function readQuietTurn(frames: ReadableStream<Uint8Array>, deadlineMs: number) {
  const projectId = parseProjectId("project-one");

  if (projectId === undefined) throw new Error("expected a valid project id");

  const started = Date.now();

  const stream = readTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: {
      finishTurn: vi.fn(),
      abandonTurn: (): ProjectThreadResult => ({
        ok: false,
        problem: { code: "turn-not-active", projectId },
      }),
    },
    now,
    bound: new TurnBound(started + deadlineMs, now),
    workspace: idleWorkspace,
    trace: turnTrace(projectId, "lease-one", undefined, started),
    frames,
  });

  const reader = stream.getReader();
  const chunks: string[] = [];

  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    chunks.push(decoder.decode(read.value));
  }

  return { chunks, closedAfterMs: Date.now() - started };
}

test("a quiet turn writes an empty line every two seconds until it settles", async () => {
  const rejected = JSON.stringify({ kind: "rejected", code: "invalid-turn-request" });

  const { chunks } = await readQuietTurn(quietFrames(4_500, [rejected]), 30_000);

  expect(chunks).toEqual([
    "\n",
    "\n",
    `${JSON.stringify({ kind: "turn-rejected", code: "invalid-turn-request" })}\n`,
  ]);
});

test("keepalives do not hold a quiet turn past its deadline", async () => {
  const { chunks, closedAfterMs } = await readQuietTurn(new ReadableStream(), 3_000);

  expect(chunks).toEqual(["\n", `${JSON.stringify({ kind: "timed-out" })}\n`]);
  expect(closedAfterMs).toBeLessThan(3_500);
});
