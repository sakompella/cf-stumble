/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { GenerationControl } from "../../src/supervisor/control/index.js";
import { Generations } from "../../src/supervisor/generations/index.js";
import { ProjectThreads } from "../../src/supervisor/threads/index.js";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { sampleSelectableCatalog } from "../project-fixtures.js";
import { connectedSupervisor } from "./helpers.js";

const NOW = 1_700_000_000_000;

const LEASE_MS = 30_000;

const PROJECT_ID = "sample-project-one";

const commit = "7200000000000000000000000000000000000001";

/**
 * Make the real storage refuse every statement containing `refused`. Everything else, including
 * `transactionSync`, stays the real storage, so a refusal inside a transaction is a real rollback.
 * `afterEach` restores the statement.
 */
function refuseStatements(storage: DurableObjectStorage, refused: string): void {
  const exec = storage.sql.exec.bind(storage.sql);

  vi.spyOn(storage.sql, "exec").mockImplementation(
    (query: string, ...bindings: SqlStorageValue[]) => {
      if (query.includes(refused)) throw new Error(`the storage refused: ${refused}`);

      return exec(query, ...bindings);
    },
  );
}

/**
 * Whether a refused write raised. A refusal must escape the transaction callback: that is what
 * rolls the transaction back, and a refusal turned into a returned value would commit whatever was
 * written before it.
 */
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
      control.execute({
        principal: { kind: "user" },
        command: { kind: "submit-candidate", harnessCommit: commit },
      });
    });

    vi.restoreAllMocks();

    return { raised, labeled: generations.all().length, epoch: generations.active().epoch };
  });

  expect(outcome).toEqual({ raised: true, labeled: 0, epoch: 0 });
});

test("a preparation check whose status write fails raises and records nothing", async () => {
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
      checks: generations.preparationCheckHistory(label).length,
      status: generations.byLabel(label)?.status,
      epoch: generations.active().epoch,
    };
  });

  expect(outcome).toEqual({ raised: true, checks: 0, status: "candidate", epoch: 1 });
});

test("a save whose write fails raises and leaves the lease and the conversation", async () => {
  const control = await connectedSupervisor("save-rolls-back");

  const outcome = await runInDurableObject(control, (_instance, state) => {
    const threads = new ProjectThreads(state.storage, () => sampleSelectableCatalog);
    const admitted = threads.startTurn(PROJECT_ID, 0, NOW, LEASE_MS);

    if (!admitted.ok) throw new Error("the first turn must be admitted");

    refuseStatements(state.storage, "UPDATE project_threads SET messages");

    const raised = raises(() => {
      threads.finishTurn(PROJECT_ID, admitted.leaseId, [], NOW + 1);
    });

    vi.restoreAllMocks();

    return { raised, after: threads.read(PROJECT_ID) };
  });

  expect(outcome).toMatchObject({
    raised: true,
    after: { ok: true, thread: { conversation: "[]", revision: 0, turnActive: true } },
  });
});

test("an admission whose lease write fails raises and admits nothing", async () => {
  const control = await connectedSupervisor("admission-rolls-back");

  const outcome = await runInDurableObject(control, (_instance, state) => {
    const threads = new ProjectThreads(state.storage, () => sampleSelectableCatalog);

    refuseStatements(state.storage, "INSERT INTO project_threads");

    const raised = raises(() => {
      threads.startTurn(PROJECT_ID, 0, NOW, LEASE_MS);
    });

    vi.restoreAllMocks();

    return { raised, after: threads.read(PROJECT_ID) };
  });

  expect(outcome).toMatchObject({
    raised: true,
    after: { ok: true, thread: { turnActive: false } },
  });
});
