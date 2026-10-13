import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect, test } from "vitest";
import { sampleProjectOne, sampleSelectableCatalog } from "../../project-fixtures.js";
import { HARNESS_PROJECT_ID } from "../../../src/selectable-projects.js";
import { startFacetTurn } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type {
  ProjectTurnFacet,
  ProjectTurnStart,
  ProjectWorkspaceNamespace,
} from "../../../src/supervisor/projects/index.js";
import { unusedCapability, wholeTurn } from "./turn-workspace-fakes.js";

/**
 * The order of a turn's start steps, with every step a recording stand-in.
 *
 * A harness checkout is reconciled before its generation mounts, because the generation's working
 * directory is that checkout. A repository is reconciled after the mount, because its clone does
 * not decide whether anything serves. The capability comes last, and nothing runs once the turn's
 * signal has aborted.
 */

const workspaceName = tenantWorkspaceName("turn-start-order");

type Recorder = Readonly<{
  events: string[];
  namespace: ProjectWorkspaceNamespace;
  facet: ProjectTurnFacet;
  streams: { cancelled: boolean }[];
}>;

function recorder(answer: (events: string[]) => Promise<void> = () => Promise.resolve()): Recorder {
  const events: string[] = [];
  const streams: { cancelled: boolean }[] = [];

  return {
    events,
    streams,
    namespace: {
      getByName: () => ({
        project: () => {
          events.push("capability");

          return Promise.resolve(unusedCapability);
        },
      }),
    },
    facet: {
      startTurn: async () => {
        events.push("start-turn");
        await answer(events);
        const observed = { cancelled: false };
        streams.push(observed);

        return new ReadableStream<Uint8Array>({
          cancel() {
            observed.cancelled = true;
          },
        });
      },
    },
  };
}

type Steps = Readonly<{
  provisionHarness?: () => Effect.Effect<boolean>;
  provision?: () => Effect.Effect<boolean>;
  mount?: () => void;
}>;

function startIn(
  recorded: Recorder,
  projectId: string,
  signal: AbortSignal,
  steps: Steps = {},
): Promise<ProjectTurnStart> {
  return Effect.runPromise(
    startFacetTurn({
      namespace: recorded.namespace,
      mount: () =>
        Effect.sync(() => {
          recorded.events.push("mount");
          steps.mount?.();

          return { fetcher: recorded.facet };
        }),
      provision: () => {
        recorded.events.push("provision");

        return steps.provision?.() ?? Effect.succeed(true);
      },
      provisionHarness: () => {
        recorded.events.push("provision-harness");

        return steps.provisionHarness?.() ?? Effect.succeed(true);
      },
      catalog: sampleSelectableCatalog,
      workspaceName,
      projectId,
      request: { prompt: "do the work", state: null },
      signal,
      remainingMs: wholeTurn,
    }),
  );
}

test("a harness turn reconciles its checkout, then mounts, then obtains the capability", async () => {
  const recorded = recorder();

  const start = await startIn(recorded, HARNESS_PROJECT_ID, new AbortController().signal);

  expect(start).toMatchObject({ ok: true });
  expect(recorded.events).toEqual(["provision-harness", "mount", "capability", "start-turn"]);
});

test("a repository turn mounts, then reconciles its clone, then obtains the capability", async () => {
  const recorded = recorder();

  const start = await startIn(recorded, sampleProjectOne.id, new AbortController().signal);

  expect(start).toMatchObject({ ok: true });
  expect(recorded.events).toEqual(["mount", "provision", "capability", "start-turn"]);
});

test("a harness checkout that cannot be reconciled is never mounted", async () => {
  const recorded = recorder();

  const start = await startIn(recorded, HARNESS_PROJECT_ID, new AbortController().signal, {
    provisionHarness: () => Effect.succeed(false),
  });

  expect(start).toEqual({ ok: false, reason: "workspace-unavailable" });
  expect(recorded.events).toEqual(["provision-harness"]);
});

test("a repository whose clone cannot be reconciled obtains no capability", async () => {
  const recorded = recorder();

  const start = await startIn(recorded, sampleProjectOne.id, new AbortController().signal, {
    provision: () => Effect.succeed(false),
  });

  expect(start).toEqual({ ok: false, reason: "workspace-unavailable" });
  expect(recorded.events).toEqual(["mount", "provision"]);
});

test("a turn that ends during the mount makes no further step", async () => {
  const recorded = recorder();
  const turn = new AbortController();

  const start = await startIn(recorded, sampleProjectOne.id, turn.signal, {
    mount: () => {
      turn.abort();
    },
  });

  expect(start).toEqual({ ok: false, reason: "turn-not-started" });
  expect(recorded.events).toEqual(["mount"]);
});

test("a turn that ended before it started touches nothing", async () => {
  const recorded = recorder();
  const turn = new AbortController();
  turn.abort();

  const start = await startIn(recorded, sampleProjectOne.id, turn.signal);

  expect(start).toEqual({ ok: false, reason: "turn-not-started" });
  expect(recorded.events).toEqual([]);
});

test("a facet that answers after the turn ended has its stream cancelled", async () => {
  const turn = new AbortController();

  const recorded = recorder(() => {
    turn.abort();

    return Promise.resolve();
  });

  const start = await startIn(recorded, sampleProjectOne.id, turn.signal);

  expect(start).toEqual({ ok: false, reason: "turn-not-started" });
  expect(recorded.streams).toEqual([{ cancelled: true }]);
});

test("a start interrupted while the facet answers cancels the stream that arrives later", async () => {
  let answer: ((frames: ReadableStream<Uint8Array>) => void) | undefined;
  let cancelled = false;
  const recorded = recorder();

  const facet: ProjectTurnFacet = {
    startTurn: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  };

  const starting = Effect.runFork(
    startFacetTurn({
      namespace: recorded.namespace,
      mount: () => Effect.succeed({ fetcher: facet }),
      provision: () => Effect.succeed(true),
      catalog: sampleSelectableCatalog,
      workspaceName,
      projectId: sampleProjectOne.id,
      request: { prompt: "do the work", state: null },
      signal: new AbortController().signal,
      remainingMs: wholeTurn,
    }),
  );

  await scheduler.wait(10);
  expect(answer, "the facet was asked to begin").toBeDefined();
  await Effect.runPromise(Fiber.interrupt(starting));

  answer?.(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await scheduler.wait(10);

  expect(cancelled).toBe(true);
});
