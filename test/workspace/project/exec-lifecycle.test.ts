import { afterEach, expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { withDecodedEvents } from "./decoded-events.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
  type ManualExecHandle,
} from "./fakes.js";

function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();

  const target = withDecodedEvents(
    new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend),
  );

  return { execBackend, target };
}

afterEach(() => {
  vi.useRealTimers();
});

test("forwards stdout as it arrives, before the terminal exit event", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "echo hi" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();

  handle.push({ name: "stdout", data: new TextEncoder().encode("hi\n") });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "stdout", seq: 0, data: "hi\n" },
  });

  handle.push({ name: "exit", exitCode: 0 });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
});

test.each([
  { name: "omitted timeout defaults to the host maximum", input: {}, expected: 600_000 },
  { name: "short timeout is used exactly as given", input: { timeoutMs: 50 }, expected: 50 },
  {
    name: "oversized timeout clamps to the host maximum",
    input: { timeoutMs: 600_000 * 10 },
    expected: 600_000,
  },
])("$name", async ({ input, expected }) => {
  const { execBackend, target } = makeTarget();
  await target.startExec({ command: "sleep 1", ...input });
  expect(execBackend.requests[0]?.timeoutMs).toBe(expected);
});

test("two staggered operations time out independently", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const first = await target.startExec({ command: "a", timeoutMs: 100 });
  const second = await target.startExec({ command: "b", timeoutMs: 300 });

  if (!first.ok || !second.ok) throw new Error("expected both operations to start");
  const firstReader = first.value.events.getReader();
  const secondReader = second.value.events.getReader();

  await vi.advanceTimersByTimeAsync(100);
  await expect(firstReader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "timed-out" },
  });

  await vi.advanceTimersByTimeAsync(200);
  await expect(secondReader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "timed-out" },
  });
  expect(execBackend.handles[0]?.killCalls).toBe(1);
  expect(execBackend.handles[1]?.killCalls).toBe(1);
});

test("cancelling the consumer stream kills the running command", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();

  await reader.cancel();

  expect(handle.killCalls).toBe(1);
});

test.each<readonly [string, (handle: ManualExecHandle) => void]>([
  [
    "EOF without an exit event",
    (handle) => {
      handle.end();
    },
  ],
  [
    "a backend read failure",
    (handle) => {
      handle.fail(new Error("stream broke"));
    },
  ],
])("%s is a failed terminal outcome", async (_case, ending) => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();

  ending(handle);
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "failed", error: { code: "backend-unavailable" } },
  });
  expect(handle.killCalls).toBe(1);
});

test.each<readonly [string, (settledId: string) => string]>([
  ["a stale, already-settled operation id", (settledId) => settledId],
  ["a well-formed but unknown operation id", () => "00000000-0000-0000-0000-000000000000:0"],
])("kill on %s is a successful no-op", async (_case, operationIdFor) => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();
  handle.push({ name: "exit", exitCode: 0 });
  await reader.read();

  await expect(target.kill(operationIdFor(started.value.operationId))).resolves.toEqual({
    ok: true,
    value: null,
  });
  expect(handle.killCalls).toBe(0);
});
