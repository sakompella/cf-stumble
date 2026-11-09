import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const READY = { status: "ready", compatibility: FACET_COMPATIBILITY } as const;

function served(generations: Generations, digit: string) {
  const { label } = generations.submit(testHarnessCommit(digit.repeat(40))).generation;
  generations.recordPreparation(label, READY);
  generations.activate({ kind: "activate", label, observedEpoch: generations.active().epoch });

  return label;
}

function run(outcome: "completed" | "failed" | "unanswered") {
  return { conversationId: "conversation", outcome, errorCode: null };
}

function inSupervisor<T>(name: string, body: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) =>
    body(state.storage),
  );
}

test("a probation failure whose rollback cannot be written keeps the generation on probation", async () => {
  const outcome = await inSupervisor("probation-rollback-atomic", (storage) => {
    const generations = new Generations(storage, FACET_COMPATIBILITY);
    const proven = served(generations, "a");
    generations.settled(run("completed"));
    served(generations, "b");

    const exec = storage.sql.exec.bind(storage.sql);
    const refused = vi.spyOn(storage.sql, "exec");
    refused.mockImplementation((query: string, ...bindings: SqlStorageValue[]) => {
      if (query.includes("UPDATE generation_state SET")) throw new Error("refused");

      return exec(query, ...bindings);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const raised = (() => {
      try {
        generations.settled(run("failed"));
      } catch {
        return true;
      }

      return false;
    })();

    refused.mockRestore();

    return { raised, proven, retried: generations.settled(run("failed"))?.command.label };
  });

  expect(outcome).toEqual({ raised: true, proven: 0, retried: 0 });
});

test("a failed re-check of the serving generation keeps it serving and a rollback target", async () => {
  const outcome = await inSupervisor("recheck-keeps-served", (storage) => {
    const generations = new Generations(storage, FACET_COMPATIBILITY);
    const first = served(generations, "a");
    served(generations, "b");
    generations.recordPreparation(first, { status: "failed" });

    return generations.activate({
      kind: "rollback",
      label: first,
      observedEpoch: generations.active().epoch,
    });
  });

  expect(outcome).toMatchObject({ ok: true, outcome: { generation: { status: "ready" } } });
});
