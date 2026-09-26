import { afterEach, expect, test, vi } from "vitest";
import { named, capturedEvents } from "../../log-capture.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { withDecodedEvents } from "./decoded-events.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

function makeTarget(options: ConstructorParameters<typeof ProjectRpcTarget>[3] = {}) {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();

  const rawTarget = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    execBackend,
    options,
  );

  const target = withDecodedEvents(rawTarget);

  return { execBackend, target, rawTarget };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([50, 500, 10_000])(
  "caps the requested timeout at the turn's remaining budget (%dms)",
  async (remainingMs) => {
    const { execBackend, target } = makeTarget({ remainingMs });
    await target.startExec({ command: "sleep 1", timeoutMs: remainingMs * 10 });

    expect(execBackend.requests[0]?.timeoutMs).toBeLessThanOrEqual(remainingMs);
  },
);

test("a transport blip does not refuse filesystem or exec operations", async () => {
  const state = { generation: 0 };
  const { execBackend, target, rawTarget } = makeTarget({ containerState: state });

  await expect(rawTarget.lstat("/")).resolves.toMatchObject({ ok: true });
  await expect(target.startExec({ command: "still-available" })).resolves.toMatchObject({
    ok: true,
  });
  expect(execBackend.requests).toHaveLength(1);
});

test("a replacement preserves filesystem access and reports one restart before exec retry", async () => {
  const state = { generation: 0 };
  const { execBackend, target, rawTarget } = makeTarget({ containerState: state });
  state.generation = 1;

  await expect(rawTarget.lstat("/")).resolves.toMatchObject({ ok: true });
  await expect(target.startExec({ command: "first-after-restart" })).resolves.toEqual({
    ok: false,
    error: { code: "container-restarted" },
  });
  await expect(target.startExec({ command: "retry-after-restart" })).resolves.toMatchObject({
    ok: true,
  });
  expect(execBackend.requests).toHaveLength(1);
});

test("endTurn kills every live exec, is idempotent, and refuses later starts", async () => {
  const events = capturedEvents();
  const { execBackend, target } = makeTarget({ remainingMs: 1_000 });
  const first = await target.startExec({ command: "one" });
  const second = await target.startExec({ command: "two" });

  expect(first.ok && second.ok).toBe(true);
  await expect(target.endTurn()).resolves.toEqual({ ok: true, value: { killed: 2 } });
  await expect(target.endTurn()).resolves.toEqual({ ok: true, value: { killed: 2 } });

  expect(execBackend.handles.map((handle) => handle.killCalls)).toEqual([1, 1]);
  await expect(target.startExec({ command: "three" })).resolves.toEqual({
    ok: false,
    error: { code: "turn-ended" },
  });
  const execEvents = named(events(), "workspace.exec");
  expect(execEvents.filter((event) => event.outcome === "killed")).toHaveLength(2);
  expect(execEvents.at(-1)).toMatchObject({
    outcome: "refused",
    errorCode: "turn-ended",
  });
});

test("the turn timer ends the capability and kills its exec", async () => {
  vi.useFakeTimers();
  const events = capturedEvents();
  const { execBackend, target } = makeTarget({ remainingMs: 50 });
  const started = await target.startExec({ command: "sleep 1" });

  if (!started.ok) throw new Error("expected exec to start");

  const reader = started.value.events.getReader();
  await vi.advanceTimersByTimeAsync(50);
  await expect(reader.read()).resolves.toMatchObject({
    value: { kind: "terminal", outcome: "killed" },
  });
  await expect(target.startExec({ command: "later" })).resolves.toEqual({
    ok: false,
    error: { code: "turn-ended" },
  });
  expect(execBackend.handles[0]?.killCalls).toBe(1);
  expect(named(events(), "workspace.exec").at(0)).toMatchObject({
    outcome: "killed",
  });
  expect(Number(named(events(), "workspace.exec").at(0)?.timeoutMs)).toBeLessThanOrEqual(50);
});

test("logs one bounded workspace.exec event when a command exits", async () => {
  const events = capturedEvents();
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "echo secret", timeoutMs: 120 });

  if (!started.ok) throw new Error("expected exec to start");
  const reader = started.value.events.getReader();
  execBackend.handles[0]?.push({ name: "exit", exitCode: 7 });
  await reader.read();

  const [event] = named(events(), "workspace.exec");
  expect(event).toMatchObject({
    level: "info",
    outcome: "exited",
    exitCode: 7,
    timeoutMs: 120,
    endedBy: null,
  });
  expect(event?.durationMs).toEqual(expect.any(Number));
  expect(JSON.stringify(event)).not.toContain("secret");
});
