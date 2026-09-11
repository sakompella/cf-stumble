// oxlint-disable anti-slop/no-runtime-typeof -- The frames under test come back across the RPC boundary, so this file narrows them before it asserts on them.

import { expect, test } from "vitest";
import { MAX_EXEC_FRAME_BYTES, ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

function makeTarget() {
  const execBackend = new FakeExecBackend();

  const target = new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    execBackend,
  );

  return { execBackend, target };
}

function outputData(frame: Uint8Array): string | undefined {
  const value: unknown = JSON.parse(new TextDecoder().decode(frame));

  if (typeof value !== "object" || value === null) return undefined;
  const data: unknown = Object.getOwnPropertyDescriptor(value, "data")?.value;

  return typeof data === "string" ? data : undefined;
}

async function frames(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];

  for (;;) {
    const next = await reader.read();

    if (next.done) return output;
    output.push(next.value);
  }
}

test("a frame at the shared byte limit is accepted exactly", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");

  const emptyFrame = new TextEncoder().encode(
    `${JSON.stringify({ kind: "stdout", seq: 0, data: "" })}\n`,
  );

  const data = "x".repeat(MAX_EXEC_FRAME_BYTES - emptyFrame.byteLength);
  const handle = execBackend.handles[0]!;
  handle.push({ name: "stdout", data: new TextEncoder().encode(data) });
  // oxlint-disable-next-line unicorn/prefer-single-call
  handle.push({ name: "exit", exitCode: 0 });

  const output = await frames(started.value.events.getReader());
  expect(output[0]?.byteLength).toBe(MAX_EXEC_FRAME_BYTES);
  expect(JSON.parse(new TextDecoder().decode(output[0] ?? new Uint8Array(0)))).toMatchObject({
    data,
  });
});

test("an output chunk over the frame limit splits into valid frames without losing bytes", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  const data = "x".repeat(MAX_EXEC_FRAME_BYTES);
  const handle = execBackend.handles[0]!;
  handle.push({ name: "stdout", data: new TextEncoder().encode(data) });
  // oxlint-disable-next-line unicorn/prefer-single-call
  handle.push({ name: "exit", exitCode: 0 });

  const output = await frames(started.value.events.getReader());
  expect(output.every((frame) => frame.byteLength <= MAX_EXEC_FRAME_BYTES)).toBe(true);
  expect(output.flatMap((frame) => outputData(frame) ?? []).join("")).toBe(data);
});
