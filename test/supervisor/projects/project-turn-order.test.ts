import * as Result from "effect/Result";
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
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";

/**
 * The order of a turn's start steps, with every step a recording stand-in.
 *
 * A harness checkout is reconciled before its generation mounts, because the generation's working
 * directory is that checkout. A repository is reconciled after the mount, because its clone does
 * not decide whether anything serves. The capability comes last, and nothing runs once the turn's
 * signal has aborted.
 */

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the stand-in facet never calls the capability; the test only records when it was obtained.
const capability = {} as ProjectRpcTargetContract;

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

          return Promise.resolve(capability);
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
  provisionHarness?: () => Promise<boolean>;
  provision?: () => Promise<boolean>;
  mount?: () => void;
}>;

function startIn(
  recorded: Recorder,
  projectId: string,
  signal: AbortSignal,
  steps: Steps = {},
): Promise<ProjectTurnStart> {
  return startFacetTurn({
    namespace: recorded.namespace,
    mount: () => {
      recorded.events.push("mount");
      steps.mount?.();

      return Promise.resolve(Result.succeed({ fetcher: recorded.facet }));
    },
    provision: () => {
      recorded.events.push("provision");

      return steps.provision?.() ?? Promise.resolve(true);
    },
    provisionHarness: () => {
      recorded.events.push("provision-harness");

      return steps.provisionHarness?.() ?? Promise.resolve(true);
    },
    catalog: sampleSelectableCatalog,
    workspaceName,
    projectId,
    request: { prompt: "do the work", state: null },
    signal,
  });
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
    provisionHarness: () => Promise.resolve(false),
  });

  expect(start).toEqual({ ok: false, reason: "workspace-unavailable" });
  expect(recorded.events).toEqual(["provision-harness"]);
});

test("a repository whose clone cannot be reconciled obtains no capability", async () => {
  const recorded = recorder();

  const start = await startIn(recorded, sampleProjectOne.id, new AbortController().signal, {
    provision: () => Promise.resolve(false),
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
