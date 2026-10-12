import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { parseProjectId, type ProjectId } from "../../../src/project-catalog.js";
import { ProjectLifecycleQueue } from "../../../src/supervisor/projects/project-lifecycle-queue.js";

/**
 * The per-project queue on its own. `project-lifecycle.test.ts` holds what it protects; these hold
 * the queue's own rules, including what an interrupted caller does to the callers behind it.
 */

function projectId(value: string): ProjectId {
  const parsed = parseProjectId(value);

  if (parsed === undefined) throw new Error(`expected a valid project id: ${value}`);

  return parsed;
}

const one = projectId("project-one");

const two = projectId("project-two");

type Held = Readonly<{ work: Effect.Effect<void>; release(): void; started(): boolean }>;

/** Work that runs until the test releases it, as a Workspace Host RPC in flight does. */
function held(log: string[], name: string): Held {
  const finish = { release: (): void => {} };
  let started = false;

  const done = new Promise<void>((resolve) => {
    finish.release = resolve;
  });

  return {
    work: Effect.sync(() => {
      started = true;
      log.push(`${name} started`);
    }).pipe(
      Effect.andThen(Effect.promise(() => done)),
      Effect.andThen(
        Effect.sync(() => {
          log.push(`${name} ended`);
        }),
      ),
    ),
    release: () => {
      finish.release();
    },
    started: () => started,
  };
}

const settle = (): Promise<void> => scheduler.wait(5);

test("operations on one project run one after another, in the order they were asked for", async () => {
  const queue = new ProjectLifecycleQueue();
  const log: string[] = [];
  const first = held(log, "first");
  const second = held(log, "second");

  const running = [
    Effect.runPromise(queue.exclusive(one, first.work)),
    Effect.runPromise(queue.exclusive(one, second.work)),
  ];

  await settle();
  expect(second.started()).toBe(false);
  first.release();
  await settle();
  second.release();
  await Promise.all(running);

  expect(log).toEqual(["first started", "first ended", "second started", "second ended"]);
});

test("different projects do not wait for each other", async () => {
  const queue = new ProjectLifecycleQueue();
  const log: string[] = [];
  const first = held(log, "one");
  const other = held(log, "two");

  const running = [
    Effect.runPromise(queue.exclusive(one, first.work)),
    Effect.runPromise(queue.exclusive(two, other.work)),
  ];

  await settle();
  expect(other.started()).toBe(true);
  first.release();
  other.release();
  await Promise.all(running);
});

test("a caller interrupted while it waits never runs, and the next still waits for the first", async () => {
  const queue = new ProjectLifecycleQueue();
  const log: string[] = [];
  const first = held(log, "first");
  const skipped = held(log, "skipped");
  const third = held(log, "third");

  const running = Effect.runPromise(queue.exclusive(one, first.work));
  const waiting = Effect.runFork(queue.exclusive(one, skipped.work));
  const last = Effect.runPromise(queue.exclusive(one, third.work));

  await settle();
  await Effect.runPromise(Fiber.interrupt(waiting));
  await settle();
  expect(third.started(), "the third may not overtake the first").toBe(false);

  first.release();
  await running;
  await settle();
  third.release();
  await last;

  expect(skipped.started()).toBe(false);
  expect(log).toEqual(["first started", "first ended", "third started", "third ended"]);
});

test("a caller interrupted while its operation runs holds the project until the work settles", async () => {
  const queue = new ProjectLifecycleQueue();
  const log: string[] = [];
  const first = held(log, "first");
  const next = held(log, "next");

  const running = Effect.runFork(queue.exclusive(one, first.work));
  await settle();
  const interrupted = Effect.runPromise(Fiber.interrupt(running));
  const after = Effect.runPromise(queue.exclusive(one, next.work));

  await settle();
  expect(next.started(), "the next may not start while the first's work can still write").toBe(
    false,
  );

  first.release();
  await interrupted;
  await settle();
  next.release();
  await after;

  expect(log).toEqual(["first started", "first ended", "next started", "next ended"]);
});
