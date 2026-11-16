import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import type { GenerationLabel } from "../../../src/supervisor/generation-state.js";
import { GenerationHistory } from "../../../src/supervisor/history/log.js";
import { r2History } from "../../../src/supervisor/history/r2-history.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";

const firstCommit = "1".repeat(40);

const secondCommit = "2".repeat(40);

afterEach(async () => {
  await reset();
});

function recorder(refusals: number) {
  const pending: Promise<void>[] = [];
  const append = r2History(env.MODULE_MAPS);
  let remaining = refusals;

  const history = new GenerationHistory(
    (commit) => {
      if (remaining > 0) {
        remaining -= 1;

        return Promise.reject(new Error("the bucket refused the put"));
      }

      return append(commit);
    },
    (promise) => {
      pending.push(promise);
    },
    () => 1_700_000_000_000,
  );

  return { history, settled: () => Promise.all(pending) };
}

async function storedText(path: string): Promise<string> {
  const object = await env.MODULE_MAPS.get(`history/${path}`);

  return object === null ? "" : object.text();
}

function epochOf(eventName: string): number {
  return Number(eventName.slice(0, eventName.indexOf("-")));
}

async function eventNames(): Promise<string[]> {
  const listed = await env.MODULE_MAPS.list({ prefix: "history/events/" });

  return listed.objects
    .map((object) => object.key.slice("history/events/".length, -".json".length))
    .toSorted((left, right) => epochOf(left) - epochOf(right));
}

const READY = { status: "ready", compatibility: FACET_COMPATIBILITY } as const;

function served(generations: Generations, commit: string): GenerationLabel {
  const { label } = generations.submit(testHarnessCommit(commit), "owner").generation;
  generations.recordPreparation(label, READY, "owner");
  const observedEpoch = generations.active().epoch;
  generations.activate({ kind: "activate", label, observedEpoch }, "owner");

  return label;
}

function recordedSupervisor(name: string, refusals: number, change: (g: Generations) => void) {
  const { history, settled } = recorder(refusals);

  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    change(
      new Generations(state.storage, FACET_COMPATIBILITY, (recorded) => {
        history.record(recorded);
      }),
    );
  }).then(settled);
}

test("every outcome leaves one event named by its epoch, and each generation record ends in its latest state", async () => {
  await recordedSupervisor("history-order", 0, (generations) => {
    const first = served(generations, firstCommit);
    served(generations, secondCommit);
    const observedEpoch = generations.active().epoch;
    generations.activate({ kind: "rollback", label: first, observedEpoch }, "owner");
  });

  expect(await eventNames()).toEqual([
    "1-submitted",
    "2-prepared",
    "3-activated",
    "4-submitted",
    "5-prepared",
    "6-activated",
    "7-rolled-back",
  ]);
  expect(JSON.parse(await storedText("generations/0.json"))).toMatchObject({
    label: 0,
    wasActive: true,
  });
  expect(JSON.parse(await storedText("generations/1.json"))).toMatchObject({
    label: 1,
    wasActive: true,
  });
});

test("an activation stores the generation record and the event as JSON objects", async () => {
  await recordedSupervisor("history-files", 0, (generations) => {
    served(generations, firstCommit);
  });

  expect(JSON.parse(await storedText("generations/0.json"))).toEqual({
    label: 0,
    harnessCommit: firstCommit,
    status: "ready",
    wasActive: true,
    facetCompatibility: FACET_COMPATIBILITY,
  });
  expect(JSON.parse(await storedText("events/3-activated.json"))).toEqual({
    kind: "activated",
    actor: "owner",
    label: 0,
    epoch: 3,
    time: "2023-11-14T22:13:20.000Z",
    outcome: null,
    errorCode: null,
  });
  const event = await env.MODULE_MAPS.head("history/events/3-activated.json");
  expect(event?.httpMetadata?.contentType).toBe("application/json");
});

test("a failed history write does not block activation or later events", async () => {
  let active: number | undefined;

  await recordedSupervisor("history-failure", 1, (generations) => {
    served(generations, firstCommit);
    active = generations.active().generation?.label;
  });

  expect(active).toBe(0);
  expect(await eventNames()).toEqual(["2-prepared", "3-activated"]);
});
