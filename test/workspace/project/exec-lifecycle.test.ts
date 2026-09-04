import { afterEach, expect, test, vi } from "vitest";
import { MAX_EXEC_TIMEOUT_MS, ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();
  const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend);
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

  // The port never exposes a buffered aggregate: nothing here could call one even by mistake.
  expect("result" in handle).toBe(false);

  handle.push({ name: "exit", exitCode: 0 });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
});

test("an omitted timeout defaults to the host maximum", async () => {
  const { execBackend, target } = makeTarget();
  await target.startExec({ command: "sleep 1" });
  expect(execBackend.requests[0]?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS);
});

test("a short timeout is used exactly as given", async () => {
  const { execBackend, target } = makeTarget();
  await target.startExec({ command: "sleep 1", timeoutMs: 50 });
  expect(execBackend.requests[0]?.timeoutMs).toBe(50);
});

test("an oversized timeout clamps to the host maximum", async () => {
  const { execBackend, target } = makeTarget();
  await target.startExec({ command: "sleep 1", timeoutMs: MAX_EXEC_TIMEOUT_MS * 10 });
  expect(execBackend.requests[0]?.timeoutMs).toBe(MAX_EXEC_TIMEOUT_MS);
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

test("a timeout settles and closes even when the backend kill call hangs forever", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x", timeoutMs: 50 });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  handle.killBehavior = () => new Promise(() => {});
  const reader = started.value.events.getReader();

  await vi.advanceTimersByTimeAsync(50);
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "timed-out" },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(handle.killCalls).toBe(1);
});

test("a timeout settles even when the backend kill call rejects", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x", timeoutMs: 50 });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  handle.killBehavior = () => Promise.reject(new Error("kill failed"));
  const reader = started.value.events.getReader();

  await vi.advanceTimersByTimeAsync(50);
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "timed-out" },
  });
});

test("an exit before the deadline suppresses the later timeout", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x", timeoutMs: 100 });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();

  handle.push({ name: "exit", exitCode: 3 });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "exited", exitCode: 3 },
  });

  await vi.advanceTimersByTimeAsync(200);
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(handle.killCalls).toBe(0);
});

test("a manual kill before the deadline suppresses the later timeout", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x", timeoutMs: 100 });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const reader = started.value.events.getReader();

  await expect(target.kill(started.value.operationId)).resolves.toEqual({ ok: true, value: null });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "killed" },
  });

  await vi.advanceTimersByTimeAsync(200);
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(execBackend.handles[0]?.killCalls).toBe(1);
});

test("stops reading backend output while one event is buffered", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;

  handle.push({ name: "stdout", data: new TextEncoder().encode("first") });
  // oxlint-disable-next-line unicorn/prefer-single-call -- Each call models one backend event.
  handle.push({ name: "stdout", data: new TextEncoder().encode("second") });
  await Promise.resolve();
  await Promise.resolve();

  expect(handle.readCalls).toBe(1);

  const reader = started.value.events.getReader();
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "stdout", seq: 0, data: "first" },
  });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "stdout", seq: 1, data: "second" },
  });
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

test("EOF without an exit event is a failed terminal outcome", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();

  handle.end();
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "failed", error: { code: "backend-unavailable" } },
  });
  expect(handle.killCalls).toBe(1);
});

test("a backend read failure is a failed terminal outcome", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  handle.fail(new Error("stream broke"));
  const reader = started.value.events.getReader();

  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "failed", error: { code: "backend-unavailable" } },
  });
  expect(handle.killCalls).toBe(1);
});

test("kill on a stale, already-settled operation id is a successful no-op", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "x" });
  if (!started.ok) throw new Error("expected startExec to succeed");
  const handle = execBackend.handles[0]!;
  const reader = started.value.events.getReader();
  handle.push({ name: "exit", exitCode: 0 });
  await reader.read();

  await expect(target.kill(started.value.operationId)).resolves.toEqual({ ok: true, value: null });
  expect(handle.killCalls).toBe(0);
});

test("kill on a well-formed but unknown operation id is a successful no-op", async () => {
  const { target } = makeTarget();
  await expect(target.kill("00000000-0000-0000-0000-000000000000:0")).resolves.toEqual({
    ok: true,
    value: null,
  });
});
