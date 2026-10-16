import { expect, test } from "vitest";
import type { BackendExecEvent } from "../../../src/workspace/project/exec-backend.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ExecEvent } from "../../../src/workspace/project/protocol.js";
import { withDecodedEvents } from "./decoded-events.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

// "€" is e2 82 ac; the first two bytes alone are a truncated sequence.
const EURO = [0xe2, 0x82, 0xac];

const TRUNCATED_EURO = EURO.slice(0, 2);

async function startOperation() {
  const execBackend = new FakeExecBackend();

  const target = withDecodedEvents(
    new ProjectRpcTarget(
      new FakeProjectFilesystemProvider(),
      new FakeProjectTransactions(),
      execBackend,
    ),
  );

  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");

  return {
    target,
    operationId: started.value.operationId,
    handle: execBackend.handles[0]!,
    events: started.value.events,
  };
}

function pushAll(
  handle: { push(event: BackendExecEvent): void },
  events: BackendExecEvent[],
): void {
  for (const event of events) handle.push(event);
}

async function readAll(events: ReadableStream<ExecEvent>): Promise<ExecEvent[]> {
  const reader = events.getReader();
  const frames: ExecEvent[] = [];

  for (;;) {
    const next = await reader.read();

    if (next.done) return frames;
    frames.push(next.value);
  }
}

function outputOf(frames: ExecEvent[], kind: "stdout" | "stderr"): string {
  return frames.flatMap((frame) => (frame.kind === kind ? [frame.data] : [])).join("");
}

/** Asserts the single terminal event comes last, so all output arrived before it. */
function terminalOf(frames: ExecEvent[]): ExecEvent {
  const terminal = frames.at(-1);

  expect(terminal?.kind).toBe("terminal");
  expect(frames.filter((frame) => frame.kind === "terminal")).toHaveLength(1);

  return terminal!;
}

test.each(["stdout", "stderr"] as const)(
  "%s: a complete character split across chunks decodes whole",
  async (kind) => {
    const { handle, events } = await startOperation();

    pushAll(handle, [
      { name: kind, data: new Uint8Array([0x61, ...EURO.slice(0, 1)]) },
      { name: kind, data: new Uint8Array(EURO.slice(1)) },
      { name: "exit", exitCode: 0 },
    ]);

    const frames = await readAll(events);

    expect(outputOf(frames, kind)).toBe("a€");
  },
);

test.each(["stdout", "stderr"] as const)(
  "%s: a truncated trailing sequence is flushed as a replacement character before the exit event",
  async (kind) => {
    const { handle, events } = await startOperation();

    pushAll(handle, [
      { name: kind, data: new Uint8Array([0x61, ...TRUNCATED_EURO]) },
      { name: "exit", exitCode: 0 },
    ]);

    const frames = await readAll(events);

    expect(outputOf(frames, kind)).toBe("a\uFFFD");
    expect(terminalOf(frames)).toMatchObject({ outcome: "exited", exitCode: 0 });
  },
);

test.each(["stdout", "stderr"] as const)(
  "%s: a backend stream that closes without an exit event flushes before the failed event",
  async (kind) => {
    const { handle, events } = await startOperation();

    handle.push({ name: kind, data: new Uint8Array([0x61, ...TRUNCATED_EURO]) });
    handle.end();

    const frames = await readAll(events);

    expect(outputOf(frames, kind)).toBe("a\uFFFD");
    expect(terminalOf(frames)).toMatchObject({ outcome: "failed" });
  },
);

test("each stream flushes its own pending bytes and no other", async () => {
  const { handle, events } = await startOperation();

  pushAll(handle, [
    { name: "stdout", data: new Uint8Array(TRUNCATED_EURO) },
    { name: "stderr", data: new Uint8Array(EURO) },
    { name: "exit", exitCode: 1 },
  ]);

  const frames = await readAll(events);

  expect(outputOf(frames, "stdout")).toBe("\uFFFD");
  expect(outputOf(frames, "stderr")).toBe("€");
});

test("a kill ends the operation without flushing a pending truncated sequence", async () => {
  const { handle, events, target, operationId } = await startOperation();

  handle.push({ name: "stdout", data: new Uint8Array(TRUNCATED_EURO) });
  await target.kill(operationId);

  const frames = await readAll(events);

  expect(outputOf(frames, "stdout")).toBe("");
  expect(terminalOf(frames)).toMatchObject({ outcome: "killed" });
});
