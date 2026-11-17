import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { generationsOf, served } from "./generation-ports.js";
import { refuseGenerationStateWrites } from "../refused-storage.js";

afterEach(async () => {
  await reset();
});

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
    const generations = generationsOf(storage);
    const proven = served(generations, "a");
    generations.settled(run("completed"));
    served(generations, "b");

    const refused = refuseGenerationStateWrites(storage);

    const raised = (() => {
      try {
        generations.settled(run("failed"));
      } catch {
        return true;
      }

      return false;
    })();

    refused();
    generations.settled(run("failed"));

    return { raised, proven, retried: generations.active().generation?.label };
  });

  expect(outcome).toEqual({ raised: true, proven: 0, retried: 0 });
});

test("a failed re-check of the serving generation keeps it serving and a rollback target", async () => {
  const outcome = await inSupervisor("recheck-keeps-served", (storage) => {
    const generations = generationsOf(storage);
    const first = served(generations, "a");
    served(generations, "b");
    generations.recordPreparation(first, { status: "failed" }, "owner");
    const observedEpoch = generations.active().epoch;

    return generations.activate({ kind: "rollback", label: first, observedEpoch }, "owner");
  });

  expect(outcome).toMatchObject({ ok: true, outcome: { generation: { status: "ready" } } });
});
