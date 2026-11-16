import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceIdleController } from "../../../src/workspace/idle-controller.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { deferredExec } from "./deferred-exec.js";
import { targetOptions } from "./target-helpers.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeTarget() {
  const clock = { nowMs: 0 };

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.nowMs,
    idleLimitMs: 1_000,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => false,
    pullContainer: () => Promise.resolve(),
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () => Effect.void,
  });

  const execBackend = new FakeExecBackend();

  const target = new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    execBackend,
    targetOptions({ activity: idle }),
  );

  return { clock, idle, execBackend, target };
}

test("an exec keeps the workspace busy until it settles, and its late handle changes nothing", async () => {
  vi.useFakeTimers();
  const { clock, idle, execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);
  clock.nowMs = 5_000;

  const started = await target.startExec({ command: "sleep 9", timeoutMs: 50 });

  expect(started.ok).toBe(true);
  expect(idle.snapshot()).toMatchObject({ inFlight: 1, lastActiveAtMs: 5_000 });

  await vi.advanceTimersByTimeAsync(49);
  expect(idle.snapshot().inFlight).toBe(1);

  clock.nowMs = 5_050;
  await vi.advanceTimersByTimeAsync(1);
  expect(idle.snapshot()).toMatchObject({ inFlight: 0, lastActiveAtMs: 5_050 });

  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(idle.snapshot().inFlight).toBe(0);
});

test("a refused exec never keeps the workspace busy", async () => {
  const { idle, target } = makeTarget();

  const refused = await target.startExec({ command: "" });

  expect(refused.ok).toBe(false);
  expect(idle.snapshot().inFlight).toBe(0);
});

test.each([
  ["lstat", (target: ProjectRpcTarget) => target.lstat("/")],
  ["readFile", (target: ProjectRpcTarget) => target.readFile("/missing")],
  [
    "writeFile",
    (target: ProjectRpcTarget) => target.writeFile("/a", new Uint8Array(), "overwrite"),
  ],
])("a %s call counts as activity without keeping the workspace busy", async (_name, call) => {
  const { clock, idle, target } = makeTarget();
  clock.nowMs = 7_000;

  await call(target);

  expect(idle.snapshot()).toMatchObject({ inFlight: 0, lastActiveAtMs: 7_000 });
});
