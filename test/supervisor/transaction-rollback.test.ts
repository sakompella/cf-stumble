import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { GenerationControl } from "../../src/supervisor/control/index.js";
import { Generations } from "../../src/supervisor/generations/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";

const commit = "7200000000000000000000000000000000000001";

function refuseStatements(storage: DurableObjectStorage, refused: string): void {
  const exec = storage.sql.exec.bind(storage.sql);

  vi.spyOn(storage.sql, "exec").mockImplementation(
    (query: string, ...bindings: SqlStorageValue[]) => {
      if (query.includes(refused)) throw new Error(`the storage refused: ${refused}`);

      return exec(query, ...bindings);
    },
  );
}

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
  vi.restoreAllMocks();
  await reset();
});

test("a submission whose epoch write fails raises and labels nothing", async () => {
  const outcome = await runInDurableObject(supervisor("submit-rolls-back"), (_instance, state) => {
    const generations = new Generations(state.storage);
    const control = new GenerationControl(generations);

    refuseStatements(state.storage, "UPDATE generation_state SET epoch");

    const raised = raises(() => {
      control.execute({ kind: "submit-candidate", harnessCommit: commit });
    });

    vi.restoreAllMocks();

    return { raised, labeled: generations.all().length, epoch: generations.active().epoch };
  });

  expect(outcome).toEqual({ raised: true, labeled: 0, epoch: 0 });
});

test("a preparation check whose status write fails raises and changes nothing", async () => {
  const outcome = await runInDurableObject(supervisor("check-rolls-back"), (_instance, state) => {
    const generations = new Generations(state.storage);

    const labeled = generations.transaction(() =>
      generations.labelInTransaction(testHarnessCommit(commit)),
    );

    const label = labeled.generation.label;

    refuseStatements(state.storage, "UPDATE generations SET status");

    const raised = raises(() => {
      generations.recordPreparationCheck(label, "passed");
    });

    vi.restoreAllMocks();

    return {
      raised,
      status: generations.byLabel(label)?.status,
      epoch: generations.active().epoch,
    };
  });

  expect(outcome).toEqual({ raised: true, status: "candidate", epoch: 1 });
});
