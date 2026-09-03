import { afterEach, expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { deferredExec } from "./deferred-exec.js";
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

test("a backend handle stuck pending past the timeout still returns an operation id and stream immediately, then times out and later kills the exact handle exactly once", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);

  const started = await target.startExec({ command: "x", timeoutMs: 50 });
  if (!started.ok)
    throw new Error("expected startExec to succeed even while the handle is pending");
  expect(started.value.operationId.length).toBeGreaterThan(0);
  const reader = started.value.events.getReader();

  await vi.advanceTimersByTimeAsync(50);
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "timed-out" },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(deferred.handle.killCalls).toBe(0);

  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(deferred.handle.killCalls).toBe(1);

  // A push onto the now-late handle must never surface as a second event on the closed stream.
  deferred.handle.push({ name: "exit", exitCode: 0 });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
});

test("a backend start rejection before the deadline is one failed terminal outcome, with no unhandled rejection", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);

  const started = await target.startExec({ command: "x", timeoutMs: 1_000 });
  if (!started.ok)
    throw new Error("expected startExec to succeed even while the handle is pending");
  const reader = started.value.events.getReader();

  deferred.reject(new Error("spawn failed"));
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "failed", error: { code: "backend-unavailable" } },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });

  // The still-armed timer must not fire a second terminal event once the rejection settled it.
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
});

test("a manual kill while the backend handle is still pending emits killed, then kills the exact handle exactly once once it later arrives", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);

  const started = await target.startExec({ command: "x", timeoutMs: 1_000 });
  if (!started.ok)
    throw new Error("expected startExec to succeed even while the handle is pending");
  const reader = started.value.events.getReader();

  await expect(target.kill(started.value.operationId)).resolves.toEqual({ ok: true, value: null });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "killed" },
  });
  expect(deferred.handle.killCalls).toBe(0);

  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(deferred.handle.killCalls).toBe(1);
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
});

test("a timeout, a manual kill, and the handle resolving all racing together settle exactly once, with exactly one exact-handle kill", async () => {
  vi.useFakeTimers();
  const { execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);

  const started = await target.startExec({ command: "x", timeoutMs: 50 });
  if (!started.ok)
    throw new Error("expected startExec to succeed even while the handle is pending");
  const reader = started.value.events.getReader();

  // The manual kill fires first, then the timeout's timer elapses, and only then does the
  // pending handle resolve. Only the first trigger may produce a terminal event or a kill call.
  const killResult = target.kill(started.value.operationId);
  await vi.advanceTimersByTimeAsync(50);
  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(killResult).resolves.toEqual({ ok: true, value: null });

  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: { kind: "terminal", seq: 0, outcome: "killed" },
  });
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(deferred.handle.killCalls).toBe(1);
});
