import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { ProjectLifecycleQueue } from "../../../src/supervisor/projects/project-lifecycle-queue.js";
import type { ProjectId } from "../../../src/project-catalog.js";
import { projectIdOf } from "../../project-fixtures.js";

const PROJECTS = ["sample-one", "sample-two", "sample-three"].map(projectIdOf);

const operation = gs.record({
  project: gs.sampledFrom(PROJECTS),
  fails: gs.booleans(),
  interrupted: gs.booleans(),
  releaseOrder: gs.integers({ minValue: 0, maxValue: 100 }),
});

type Event = Readonly<{ kind: "start" | "end"; index: number }>;

async function letOtherWorkRun(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

type Entry = Readonly<{
  project: ProjectId;
  fails: boolean;
  interrupted: boolean;
  releaseOrder: number;
}>;

type Run = ReturnType<typeof launch>;

function launch(
  queue: ProjectLifecycleQueue,
  events: Event[],
  exits: Map<number, Exit.Exit<void, string>>,
  entry: Entry,
  index: number,
) {
  const gate = Deferred.makeUnsafe<void>();

  const record = (kind: Event["kind"]) =>
    Effect.sync(() => {
      events.push({ kind, index });
    });

  const fiber = Effect.runFork(
    queue
      .exclusive(
        entry.project,
        record("start").pipe(
          Effect.andThen(Deferred.await(gate).pipe(Effect.ensuring(record("end")))),
          Effect.andThen(entry.fails ? Effect.fail("failed") : Effect.void),
        ),
      )
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            exits.set(index, exit);
          }),
        ),
      ),
  );

  return { ...entry, index, gate, fiber };
}

function expectOneAtATimeInOrder(events: readonly Event[], runs: readonly Run[]): void {
  for (const project of PROJECTS) {
    const mine = new Set(runs.flatMap((run) => (run.project === project ? [run.index] : [])));
    const own = events.filter((event) => mine.has(event.index));
    const starts = own.flatMap((event) => (event.kind === "start" ? [event.index] : []));
    let running = 0;

    expect(starts).toEqual(starts.toSorted((left, right) => left - right));

    for (const event of own) {
      running += event.kind === "start" ? 1 : -1;
      expect(running).toBeLessThanOrEqual(1);
    }
  }
}

test("operations on one project run one at a time in submission order, whatever happens to the others", async () => {
  await hegel.testAsync(async (tc) => {
    const queue = new ProjectLifecycleQueue();
    const events: Event[] = [];
    const exits = new Map<number, Exit.Exit<void, string>>();

    const runs = tc
      .draw(gs.arrays(operation, { minSize: 1, maxSize: 8 }))
      .map((entry, index) => launch(queue, events, exits, entry, index));

    for (const run of runs) {
      if (run.interrupted) Effect.runFork(Fiber.interrupt(run.fiber));
    }

    await letOtherWorkRun();

    const started = new Set(events.map((event) => event.index));

    for (const project of PROJECTS) {
      const first = runs.find((run) => run.project === project && !run.interrupted);

      if (first !== undefined) expect(started.has(first.index)).toBe(true);
    }

    for (const run of runs.toSorted((left, right) => left.releaseOrder - right.releaseOrder)) {
      Deferred.doneUnsafe(run.gate, Exit.void);
      await letOtherWorkRun();
    }

    for (const run of runs.filter((candidate) => !candidate.interrupted)) {
      const exit = exits.get(run.index);

      expect(exit, "an operation finishes even when an earlier one failed").toBeDefined();
      expect(exit !== undefined && Exit.isFailure(exit)).toBe(run.fails);
    }

    expectOneAtATimeInOrder(events, runs);
  });
});
