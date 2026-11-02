import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import { MAX_EXEC_FRAME_BYTES } from "../../../src/workspace/project/protocol.js";
import { FakeExecBackend } from "./fakes.js";

const text = gs.text({ alphabet: "ab'\"\\\n\u0001é日🙂", maxSize: 48 });

type DecodedEvent = {
  kind: string;
  seq?: number;
  data?: string;
  outcome?: string;
  exitCode?: number;
};

function splitBytes(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const points = [...new Set([0, ...offsets, bytes.length])]
    .filter((point) => point >= 0 && point <= bytes.length)
    .toSorted((a, b) => a - b);

  return points.slice(1).flatMap((end, index) => {
    const chunk = bytes.slice(points[index], end);

    return chunk.length > 0 ? [chunk] : [];
  });
}

function payload(tc: hegel.TestCase, offsets: number[]) {
  const repeated = tc.draw(gs.integers({ minValue: 0, maxValue: 700 }));
  const data = `é日🙂${tc.draw(text).repeat(repeated)}`;
  const bytes = new TextEncoder().encode(data);

  return {
    data,
    bytes,
    offsets: [1, 3, 6, ...offsets.map((offset) => offset % (bytes.length + 1))],
  };
}

async function runOperation(
  stdout: { bytes: Uint8Array; offsets: number[] },
  stderr: { bytes: Uint8Array; offsets: number[] },
): Promise<Uint8Array[]> {
  const backend = new FakeExecBackend();

  const operation = startExecOperation(
    backend,
    { command: "x", cwd: "/workspace", timeoutMs: 60_000 },
    () => {},
  );

  await Promise.resolve();

  const handle = backend.handles[0]!;

  for (const chunk of splitBytes(stdout.bytes, stdout.offsets)) {
    handle.push({ name: "stdout", data: chunk });
  }

  for (const chunk of splitBytes(stderr.bytes, stderr.offsets)) {
    handle.push({ name: "stderr", data: chunk });
  }

  handle.push({ name: "exit", exitCode: 0 });

  const reader = operation.events.getReader();
  const frames: Uint8Array[] = [];

  for (;;) {
    const next = await reader.read();

    if (next.done) return frames;

    frames.push(next.value);
  }
}

function isDecodedEvent(value: unknown): value is DecodedEvent {
  if (value === null || typeof value !== "object") return false;

  return "kind" in value && typeof value.kind === "string";
}

function eventsOf(frames: readonly Uint8Array[]): DecodedEvent[] {
  return frames.map((frame) => {
    const value: unknown = JSON.parse(new TextDecoder().decode(frame));

    if (!isDecodedEvent(value)) throw new Error("expected a decoded event object");

    return value;
  });
}

test("reassembles stdout and stderr after arbitrary UTF-8 backend chunking", async () => {
  await hegel.testAsync(
    async (tc) => {
      const offsets = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 300_000 }), { maxSize: 10 }),
      );

      const stdout = payload(tc, offsets);

      const stderr = payload(tc, offsets);
      const events = eventsOf(await runOperation(stdout, stderr));

      expect(
        events
          .filter((event) => event.kind === "stdout")
          .map((event) => event.data ?? "")
          .join(""),
      ).toBe(stdout.data);
      expect(
        events
          .filter((event) => event.kind === "stderr")
          .map((event) => event.data ?? "")
          .join(""),
      ).toBe(stderr.data);
    },
    { testCases: 60 },
  );
});

test("keeps every frame bounded and emits one ordered terminal event", async () => {
  await hegel.testAsync(
    async (tc) => {
      const offsets = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 300_000 }), { maxSize: 10 }),
      );

      const stdout = payload(tc, offsets);

      const stderr = payload(tc, offsets);
      const frames = await runOperation(stdout, stderr);
      const events = eventsOf(frames);

      expect(frames.every((frame) => frame.byteLength <= MAX_EXEC_FRAME_BYTES)).toBe(true);
      expect(frames.every((frame) => frame.at(-1) === 0x0a)).toBe(true);
      expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
      expect(events.filter((event) => event.kind === "terminal")).toEqual([
        { kind: "terminal", seq: events.length - 1, outcome: "exited", exitCode: 0 },
      ]);
    },
    { testCases: 60 },
  );
});

async function runToEnd(
  stdout: Uint8Array[],
  stderr: Uint8Array[],
  ending: "exit" | "eof",
): Promise<DecodedEvent[]> {
  const backend = new FakeExecBackend();

  const operation = startExecOperation(
    backend,
    { command: "x", cwd: "/workspace", timeoutMs: 60_000 },
    () => {},
  );

  await Promise.resolve();

  const handle = backend.handles[0]!;

  for (const data of stdout) handle.push({ name: "stdout", data });

  for (const data of stderr) handle.push({ name: "stderr", data });

  if (ending === "exit") handle.push({ name: "exit", exitCode: 0 });
  else handle.end();

  const reader = operation.events.getReader();
  const frames: Uint8Array[] = [];

  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    frames.push(next.value);
  }

  return eventsOf(frames);
}

const cutBytes = gs
  .tuples(text, gs.integers({ minValue: 0, maxValue: 200 }), gs.binary({ maxSize: 3 }))
  .map(([value, keep, tail]) => {
    const encoded = new TextEncoder().encode(value);

    return new Uint8Array([...encoded.slice(0, keep % (encoded.length + 1)), ...tail]);
  });

test("output equals a one-shot decode of the bytes, however they are cut and however the stream ends", async () => {
  await hegel.testAsync(
    async (tc) => {
      const stdout = tc.draw(cutBytes);
      const stderr = tc.draw(cutBytes);

      const offsets = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 200 }), { maxSize: 6 }),
      );

      const ending = tc.draw(gs.sampledFrom(["exit", "eof"] as const));

      const events = await runToEnd(
        splitBytes(stdout, offsets),
        splitBytes(stderr, offsets),
        ending,
      );

      const outputOf = (kind: string) =>
        events
          .filter((event) => event.kind === kind)
          .map((event) => event.data ?? "")
          .join("");

      expect(outputOf("stdout")).toBe(new TextDecoder().decode(stdout));
      expect(outputOf("stderr")).toBe(new TextDecoder().decode(stderr));
      expect(events.at(-1)).toMatchObject({
        kind: "terminal",
        outcome: ending === "exit" ? "exited" : "failed",
      });
    },
    { testCases: 200 },
  );
});
