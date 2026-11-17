import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { refuseGenerationStateWrites } from "../refused-storage.js";
import { served, spyPorts } from "./generation-ports.js";

afterEach(async () => {
  await reset();
});

function run(outcome: "completed" | "failed") {
  return { conversationId: "conversation", outcome, errorCode: null };
}

function inSupervisor<T>(name: string, body: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
    body(state.storage),
  );
}

function observed(storage: DurableObjectStorage) {
  const seen: { label: number | undefined; epoch: number; instance: number }[] = [];
  const ports = spyPorts();

  const generations = new Generations(storage, FACET_COMPATIBILITY, {
    ...ports,
    facetReplaced: () => {
      ports.facetReplaced();
      const { generation, epoch } = generations.active();
      seen.push({ label: generation?.label, epoch, instance: generations.servingInstance() });
    },
  });

  return { generations, ports, seen };
}

test("an activation and a rollback each replace the facet once, after the selection names the new generation", async () => {
  const outcome = await inSupervisor("replaces-on-activation", (storage) => {
    const { generations, ports, seen } = observed(storage);
    const first = served(generations, "a");
    const second = served(generations, "b");
    const { epoch } = generations.active();
    generations.activate({ kind: "rollback", label: first, observedEpoch: epoch }, "owner");

    return { seen, calls: ports.facetReplaced.mock.calls.length, first, second, epoch };
  });

  expect(outcome.calls).toBe(3);
  expect(outcome.seen).toEqual([
    { label: outcome.first, epoch: 3, instance: 1 },
    { label: outcome.second, epoch: 6, instance: 2 },
    { label: outcome.first, epoch: 7, instance: 3 },
  ]);
});

test("a probation rollback replaces the facet once and serves the fallback", async () => {
  const outcome = await inSupervisor("replaces-on-probation", (storage) => {
    const { generations, ports, seen } = observed(storage);
    const proven = served(generations, "a");
    generations.settled(run("completed"));
    served(generations, "b");
    const before = ports.facetReplaced.mock.calls.length;
    generations.settled(run("failed"));

    return {
      proven,
      seen: seen.slice(before),
      calls: ports.facetReplaced.mock.calls.length - before,
    };
  });

  expect(outcome.calls).toBe(1);
  expect(outcome.seen).toEqual([{ label: outcome.proven, epoch: 7, instance: 3 }]);
});

test("submitting, preparing, a repeated activation, a refused rollback and a settled turn replace nothing", async () => {
  const calls = await inSupervisor("replaces-nothing", (storage) => {
    const { generations, ports } = observed(storage);
    const label = served(generations, "a");
    const before = ports.facetReplaced.mock.calls.length;
    const { epoch } = generations.active();
    generations.submit(testHarnessCommit("c".repeat(40)), "owner");
    generations.activate({ kind: "activate", label, observedEpoch: epoch }, "owner");
    generations.activate({ kind: "rollback", label, observedEpoch: epoch - 1 }, "owner");
    generations.settled(run("completed"));
    generations.settled(run("failed"));

    return ports.facetReplaced.mock.calls.length - before;
  });

  expect(calls).toBe(0);
});

test("an activation whose selection write fails leaves the instance and the facet alone", async () => {
  const outcome = await inSupervisor("replaces-atomically", (storage) => {
    const { generations, ports } = observed(storage);
    const first = served(generations, "a");
    const next = generations.submit(testHarnessCommit("b".repeat(40)), "owner").generation.label;
    generations.recordPreparation(
      next,
      { status: "ready", compatibility: FACET_COMPATIBILITY },
      "owner",
    );

    const before = {
      instance: generations.servingInstance(),
      calls: ports.facetReplaced.mock.calls.length,
    };

    const allowWrites = refuseGenerationStateWrites(storage);

    const raised = (() => {
      try {
        generations.activate(
          { kind: "activate", label: next, observedEpoch: generations.active().epoch },
          "owner",
        );
      } catch {
        return true;
      }

      return false;
    })();

    allowWrites();

    return {
      raised,
      first,
      before,
      after: {
        instance: generations.servingInstance(),
        calls: ports.facetReplaced.mock.calls.length,
      },
      active: generations.active().generation?.label,
    };
  });

  expect(outcome.raised).toBe(true);
  expect(outcome.after).toEqual(outcome.before);
  expect(outcome.active).toBe(outcome.first);
});
