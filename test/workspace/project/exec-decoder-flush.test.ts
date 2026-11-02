import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ExecEvent } from "../../../src/workspace/project/protocol.js";
import { withDecodedEvents } from "./decoded-events.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

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

function terminalOf(frames: ExecEvent[]): ExecEvent {
  const terminal = frames.at(-1);

  expect(terminal?.kind).toBe("terminal");
  expect(frames.filter((frame) => frame.kind === "terminal")).toHaveLength(1);

  return terminal!;
}

test("a kill ends the operation without flushing a pending truncated sequence", async () => {
  const { handle, events, target, operationId } = await startOperation();

  handle.push({ name: "stdout", data: new Uint8Array(TRUNCATED_EURO) });
  await target.kill(operationId);

  const frames = await readAll(events);

  expect(outputOf(frames, "stdout")).toBe("");
  expect(terminalOf(frames)).toMatchObject({ outcome: "killed" });
});
