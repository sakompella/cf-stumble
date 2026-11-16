import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { trackedWork, WorkspaceIdleController } from "../../src/workspace/idle-controller.js";
import { eventually, tick } from "../eventually.js";

const LIMIT = 10_000;

function controller(closeWorkspace: () => Promise<void> = () => Promise.resolve()) {
  const clock = { now: 1_000 };
  const calls: string[] = [];

  const idle = new WorkspaceIdleController({
    nowMs: () => clock.now,
    idleLimitMs: LIMIT,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => true,
    pullContainer: () => Promise.resolve(),
    closeWorkspace: () => {
      calls.push("close");

      return closeWorkspace();
    },
    stopContainer: () =>
      Effect.sync(() => {
        calls.push("destroy");
      }),
  });

  return { idle, clock, calls };
}

test("interrupted work stays in flight until its native call settles", async () => {
  const { idle } = controller();
  const native = { started: false, settle: (): void => {} };

  const call = new Promise<void>((resolve) => {
    native.settle = resolve;
  });

  const fiber = Effect.runFork(
    trackedWork(
      idle,
      Effect.promise(() => {
        native.started = true;

        return call;
      }),
    ),
  );

  await eventually(() => {
    expect(native.started).toBe(true);
  });
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  await tick();

  expect(idle.snapshot().inFlight, "the interruption waits for the native call").toBe(1);

  native.settle();
  await interrupted;

  expect(idle.snapshot().inFlight).toBe(0);
});

test("work that arrives during an idle stop's close keeps the container, and runs once the stop settles", async () => {
  const gate = { open: (): void => {} };

  const closing = new Promise<void>((resolve) => {
    gate.open = resolve;
  });

  const { idle, clock, calls } = controller(() => closing);
  idle.begin()();
  clock.now = 1_000 + LIMIT + 1;
  const alarm = idle.onAlarm();
  await eventually(() => {
    expect(calls).toEqual(["close"]);
  });

  let ran = false;

  const work = Effect.runPromise(
    trackedWork(
      idle,
      Effect.sync(() => {
        ran = true;
      }),
    ),
  );

  await tick();

  expect(ran, "the work waits for the stop").toBe(false);

  gate.open();
  await alarm;
  await work;

  expect(ran).toBe(true);
  expect(calls, "the close saw the waiting work, so the container is kept").toEqual(["close"]);
});

test("failed and defective work both end their count", async () => {
  const { idle } = controller();

  await Effect.runPromise(Effect.result(trackedWork(idle, Effect.fail("refused"))));
  await Effect.runPromiseExit(trackedWork(idle, Effect.die(new Error("defect"))));

  expect(idle.snapshot().inFlight).toBe(0);
});
