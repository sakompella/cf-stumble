import { expect, test, vi, afterEach } from "vitest";
import type { ProjectActivity } from "../../../src/workspace/idle-controller.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { deferredExec } from "./deferred-exec.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

afterEach(() => {
  vi.useRealTimers();
});

class CountingActivity implements ProjectActivity {
  open = 0;
  begun = 0;
  touched = 0;

  begin(): () => void {
    this.open += 1;
    this.begun += 1;

    return () => {
      this.open -= 1;
    };
  }

  touch(): void {
    this.touched += 1;
  }
}

function makeTarget() {
  const activity = new CountingActivity();
  const execBackend = new FakeExecBackend();

  const target = new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    execBackend,
    { activity },
  );

  return { activity, execBackend, target };
}

test("an exec holds the workspace until it settles, then releases it exactly once", async () => {
  vi.useFakeTimers();
  const { activity, execBackend, target } = makeTarget();
  const deferred = deferredExec();
  execBackend.deferNextExec(deferred);

  const started = await target.startExec({ command: "sleep 9", timeoutMs: 50 });

  expect(started.ok).toBe(true);
  expect(activity.open, "an exec that has not settled holds the workspace").toBe(1);

  await vi.advanceTimersByTimeAsync(49);
  expect(activity.open).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(activity.open, "the timeout settles the exec").toBe(0);

  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(activity.open, "a late handle does not release a second time").toBe(0);
  expect(activity.begun).toBe(1);
});

test("a refused exec never holds the workspace", async () => {
  const { activity, target } = makeTarget();

  const refused = await target.startExec({ command: "" });

  expect(refused.ok).toBe(false);
  expect(activity.begun).toBe(0);
});

test.each([
  ["lstat", (target: ProjectRpcTarget) => target.lstat("/")],
  ["readFile", (target: ProjectRpcTarget) => target.readFile("/missing")],
  [
    "writeFile",
    (target: ProjectRpcTarget) => target.writeFile("/a", new Uint8Array(), "overwrite"),
  ],
])("a %s call marks activity and does not hold the workspace", async (_name, call) => {
  const { activity, target } = makeTarget();

  await call(target);

  expect(activity.touched).toBeGreaterThan(0);
  expect(activity.open).toBe(0);
});

test("starting an exec marks activity", async () => {
  const { activity, execBackend, target } = makeTarget();
  execBackend.deferNextExec(deferredExec());

  await target.startExec({ command: "sleep 9" });

  expect(activity.touched).toBeGreaterThan(0);
});
