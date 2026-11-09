import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import type { HistoryCommit } from "../../../src/supervisor/history/commits.js";
import { importGenerations } from "../../../src/supervisor/history/import.js";
import { GenerationHistory } from "../../../src/supervisor/history/log.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";

const firstCommit = "1".repeat(40);

const secondCommit = "2".repeat(40);

afterEach(async () => {
  await reset();
});

function recorder(failures: number) {
  const commits: HistoryCommit[] = [];
  const pending: Promise<void>[] = [];
  let remaining = failures;

  const history = new GenerationHistory(
    (commit) => {
      if (remaining > 0) {
        remaining -= 1;

        return Promise.reject(new Error("the repository refused the push"));
      }

      commits.push(commit);

      return Promise.resolve();
    },
    (promise) => {
      pending.push(promise);
    },
    () => 1_700_000_000_000,
  );

  return { commits, history, settled: () => Promise.all(pending) };
}

test("each outcome appends one commit, in order, after the transaction", async () => {
  const { commits, history, settled } = recorder(0);

  await runInDurableObject(env.SUPERVISOR.getByName("history-order"), (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY, (change) => {
      history.record(change);
    });

    const first = generations.submit(testHarnessCommit(firstCommit)).generation.label;
    generations.recordPreparation(first, { status: "ready", compatibility: FACET_COMPATIBILITY });
    generations.activate({
      kind: "activate",
      label: first,
      observedEpoch: generations.active().epoch,
    });
    const second = generations.submit(testHarnessCommit(secondCommit)).generation.label;
    generations.recordPreparation(second, { status: "ready", compatibility: FACET_COMPATIBILITY });
    generations.activate({
      kind: "activate",
      label: second,
      observedEpoch: generations.active().epoch,
    });
    generations.activate({
      kind: "rollback",
      label: first,
      observedEpoch: generations.active().epoch,
    });
  });

  await settled();

  expect(commits.map((commit) => commit.message)).toEqual([
    "submitted generation 0",
    "prepared generation 0",
    "activated generation 0",
    "submitted generation 1",
    "prepared generation 1",
    "activated generation 1",
    "rolled-back generation 0",
  ]);
});

test("a commit holds the generation record and the event", async () => {
  const { commits, history, settled } = recorder(0);

  await runInDurableObject(env.SUPERVISOR.getByName("history-files"), (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY, (change) => {
      history.record(change);
    });

    const first = generations.submit(testHarnessCommit(firstCommit)).generation.label;
    generations.recordPreparation(first, { status: "ready", compatibility: FACET_COMPATIBILITY });
    generations.activate({
      kind: "activate",
      label: first,
      observedEpoch: generations.active().epoch,
    });
  });

  await settled();

  const last = commits.at(-1);

  expect(Object.keys(last?.files ?? {})).toEqual(["generations/0.json", "events/3-activated.json"]);
  expect(JSON.parse(last?.files["generations/0.json"] ?? "")).toEqual({
    label: 0,
    harnessCommit: firstCommit,
    status: "ready",
    wasActive: true,
    facetCompatibility: FACET_COMPATIBILITY,
  });
  expect(JSON.parse(last?.files["events/3-activated.json"] ?? "")).toEqual({
    kind: "activated",
    label: 0,
    epoch: 3,
    time: "2023-11-14T22:13:20.000Z",
    outcome: null,
    errorCode: null,
  });
});

test("a failed history write does not block activation or later commits", async () => {
  const { commits, history, settled } = recorder(1);

  const active = await runInDurableObject(
    env.SUPERVISOR.getByName("history-failure"),
    (_instance, state) => {
      const generations = new Generations(state.storage, FACET_COMPATIBILITY, (change) => {
        history.record(change);
      });

      const label = generations.submit(testHarnessCommit(firstCommit)).generation.label;
      generations.recordPreparation(label, { status: "ready", compatibility: FACET_COMPATIBILITY });
      generations.activate({ kind: "activate", label, observedEpoch: generations.active().epoch });

      return generations.active().generation?.label;
    },
  );

  await settled();

  expect(active).toBe(0);
  expect(commits.map((commit) => commit.message)).toEqual([
    "prepared generation 0",
    "activated generation 0",
  ]);
});

test("existing generations import as the first commit once", async () => {
  const { commits, history, settled } = recorder(0);

  await runInDurableObject(env.SUPERVISOR.getByName("history-import"), async (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY);
    generations.submit(testHarnessCommit(firstCommit));
    generations.submit(testHarnessCommit(secondCommit));

    importGenerations(history, generations, state.storage.kv);
    await settled();
    importGenerations(history, generations, state.storage.kv);
    await settled();
  });

  expect(commits.map((commit) => Object.keys(commit.files))).toEqual([
    ["generations/0.json", "generations/1.json"],
  ]);
});
