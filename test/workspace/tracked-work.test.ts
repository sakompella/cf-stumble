import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { trackedWork, WorkspaceIdleController } from "../../src/workspace/idle-controller.js";

/**
 * Host work stays counted as in flight for as long as its native call runs. The Host cannot cancel
 * a Computer call it has made, so an interruption must not end the count early: an idle check that
 * saw nothing in flight would stop the container under a command that is still running.
 */

function controller() {
  return new WorkspaceIdleController({
    nowMs: () => 1_000,
    idleLimitMs: 10_000,
    setAlarm: () => Promise.resolve(),
    containerRunning: () => true,
    closeWorkspace: () => Promise.resolve(),
    stopContainer: () => Promise.resolve(),
  });
}

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

test("interrupted work stays in flight until its native call settles", async () => {
  const idle = controller();
  const native = { settle: (): void => {} };

  const call = new Promise<void>((resolve) => {
    native.settle = resolve;
  });

  const fiber = Effect.runFork(
    trackedWork(
      idle,
      Effect.promise(() => call),
    ),
  );

  await tick();
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
  await tick();

  expect(idle.snapshot().inFlight, "the interruption waits for the native call").toBe(1);

  native.settle();
  await interrupted;

  expect(idle.snapshot().inFlight).toBe(0);
});

test("work is counted before it waits for an idle stop in progress", async () => {
  const order: string[] = [];
  const idle = controller();

  const activity = {
    begin: () => {
      order.push("begin");

      return idle.begin();
    },
    settled: () => {
      order.push("settled");

      return idle.settled();
    },
  };

  await Effect.runPromise(
    trackedWork(
      activity,
      Effect.sync(() => order.push("work")),
    ),
  );

  expect(order).toEqual(["begin", "settled", "work"]);
});

test("failed and defective work both end their count", async () => {
  const idle = controller();

  await Effect.runPromise(Effect.result(trackedWork(idle, Effect.fail("refused"))));
  await Effect.runPromise(Effect.exit(trackedWork(idle, Effect.die(new Error("defect")))));

  expect(idle.snapshot().inFlight).toBe(0);
});
