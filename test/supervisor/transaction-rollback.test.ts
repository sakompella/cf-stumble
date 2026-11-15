import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { FACET_COMPATIBILITY } from "../../src/facet/runtime-contract.js";
import { afterEach, expect, test } from "vitest";
import { Generations } from "../../src/supervisor/generations.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { label } from "./generations/fixtures.js";
import { refuseGenerationStateWrites } from "./refused-storage.js";

const commit = "7200000000000000000000000000000000000001";

function raises(operation: () => void): boolean {
  try {
    operation();
  } catch {
    return true;
  }

  return false;
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("a submission whose epoch write fails raises and labels nothing", async () => {
  const outcome = await runInDurableObject(supervisor("submit-rolls-back"), (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY);
    const allowWrites = refuseGenerationStateWrites(state.storage);

    const raised = raises(() => {
      generations.submit(testHarnessCommit(commit), "owner");
    });

    allowWrites();

    return { raised, labeled: generations.byLabel(label(0)), epoch: generations.active().epoch };
  });

  expect(outcome).toEqual({ raised: true, labeled: undefined, epoch: 0 });
});

test("a preparation check whose selection write fails raises and changes nothing", async () => {
  const outcome = await runInDurableObject(supervisor("check-rolls-back"), (_instance, state) => {
    const generations = new Generations(state.storage, FACET_COMPATIBILITY);
    const { label: submitted } = generations.submit(testHarnessCommit(commit), "owner").generation;
    const allowWrites = refuseGenerationStateWrites(state.storage);

    const raised = raises(() => {
      generations.recordPreparation(
        submitted,
        { status: "ready", compatibility: FACET_COMPATIBILITY },
        "owner",
      );
    });

    allowWrites();

    return {
      raised,
      status: generations.byLabel(submitted)?.status,
      epoch: generations.active().epoch,
    };
  });

  expect(outcome).toEqual({ raised: true, status: "candidate", epoch: 1 });
});
