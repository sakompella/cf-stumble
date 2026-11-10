import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import {
  startExecOperation,
  type TerminalEvent,
} from "../../../src/workspace/project/exec-operation.js";
import { FakeExecBackend } from "./fakes.js";

const encoder = new TextEncoder();

function start() {
  const backend = new FakeExecBackend();
  const settled: TerminalEvent[] = [];

  const operation = startExecOperation(
    backend,
    { command: "x", cwd: "/workspace", timeoutMs: 60_000 },
    (terminal) => {
      settled.push(terminal);
    },
  );

  return { backend, operation, settled };
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

const decodeFrame = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.String,
      seq: Schema.Number,
      data: Schema.optionalKey(Schema.String),
      outcome: Schema.optionalKey(Schema.String),
    }),
  ),
);

type Frame = ReturnType<typeof decodeFrame>;

function decode(frame: Uint8Array): Frame {
  return decodeFrame(new TextDecoder().decode(frame));
}

test("every output chunk reaches the reader in order, numbered from zero, before the terminal", async () => {
  const { backend, operation } = start();
  await ticks(2);
  const handle = backend.handles[0]!;
  const sent: [string, string][] = [];

  for (let index = 0; index < 200; index += 1) {
    const kind = index % 3 === 0 ? "stderr" : "stdout";
    sent.push([kind, `${index}\n`]);
    handle.push({ name: kind, data: encoder.encode(`${index}\n`) });
  }

  handle.push({ name: "exit", exitCode: 0 });
  const frames: Frame[] = [];

  for await (const frame of operation.events) frames.push(decode(frame));

  expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index));
  expect(frames.slice(0, -1).map((frame) => [frame.kind, frame.data])).toEqual(sent);
  expect(frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "exited" });
});

test("the backend is read only as fast as the reader reads, and a cancel mid-stream stops and kills it", async () => {
  const { backend, operation, settled } = start();
  await ticks(2);
  const handle = backend.handles[0]!;

  for (let index = 0; index < 50; index += 1) {
    handle.push({ name: "stdout", data: encoder.encode(`${index}\n`) });
  }

  await ticks(20);
  expect(handle.readCalls).toBe(1);

  const reader = operation.events.getReader();

  for (let index = 0; index < 5; index += 1) await reader.read();
  await ticks(20);
  expect(handle.readCalls).toBe(6);

  await reader.cancel();
  await ticks(20);
  const readsAtCancel = handle.readCalls;
  handle.push({ name: "stdout", data: encoder.encode("late\n") });
  await ticks(20);

  expect(handle.readCalls).toBe(readsAtCancel);
  expect(handle.killCalls).toBe(1);
  expect(settled.map((terminal) => terminal.outcome)).toEqual(["killed"]);
});
