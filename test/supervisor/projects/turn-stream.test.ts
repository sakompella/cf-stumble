import { expect, test, vi } from "vitest";
import { TurnBound } from "../../../src/supervisor/projects/turn-bound.js";
import { projectTurnStream } from "../../../src/supervisor/projects/turn-stream.js";
import { turnTrace } from "../../../src/supervisor/projects/turn-log.js";
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

  const stream = projectTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: { finishTurn: vi.fn(), abandonTurn },
    now,
    bound,
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

  const stream = projectTurnStream({
    projectId,
    leaseId: "lease-one",
    threads: { finishTurn, abandonTurn },
    now,
    bound,
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
