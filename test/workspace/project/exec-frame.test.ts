import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
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

async function frames(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];

  for (;;) {
    const next = await reader.read();

    if (next.done) return output;
    output.push(next.value);
  }
}

test("output that fills a frame exactly to the byte limit arrives in one frame", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");

  const emptyFrame = new TextEncoder().encode(
    `${JSON.stringify({ kind: "stdout", seq: 0, data: "" })}\n`,
  );

  const data = "x".repeat(65_536 - emptyFrame.byteLength);
  const handle = execBackend.handles[0]!;
  handle.push(
    { name: "stdout", data: new TextEncoder().encode(data) },
    { name: "exit", exitCode: 0 },
  );

  const output = await frames(started.value.events.getReader());
  expect(output[0]?.byteLength).toBe(65_536);
  expect(JSON.parse(new TextDecoder().decode(output[0] ?? new Uint8Array(0)))).toMatchObject({
    data,
  });
});
