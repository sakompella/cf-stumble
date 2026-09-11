/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { Result } from "better-result";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  absentModuleMapBuilder,
  encodeModuleMap,
  HarnessArtifacts,
  ModuleMapStore,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  HarnessBuildResult,
  HarnessModuleMapBuilder,
  ModuleMapStorage,
} from "../../../src/supervisor/artifacts/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

const modelRoute = workerExports.ModelRoute({});

const commits = {
  built: "1000000000000000000000000000000000000001",
  stored: "1000000000000000000000000000000000000002",
  failed: "1000000000000000000000000000000000000004",
  unstorable: "1000000000000000000000000000000000000005",
  invalid: "not-a-harness-commit",
} as const;

function builtModuleMap(harnessCommit: string): MainHarnessArtifactInput {
  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      {
        name: "main.js",
        source: `
import { DurableObject } from "cloudflare:workers";
import { body } from "./body.js";
export class MainFacet extends DurableObject {
  fetch() { return new Response(body); }
}
export default { fetch() { return new Response(body); } };
`,
      },
      { name: "body.js", source: 'export const body = "built module map";\n' },
    ],
  };
}

/** A build workspace stands in for Computer here: it reports one module map and counts its runs. */
class CountingBuilder implements HarnessModuleMapBuilder {
  builds = 0;

  build(harnessCommit: string): Promise<HarnessBuildResult> {
    this.builds += 1;

    return Promise.resolve(Result.ok(builtModuleMap(harnessCommit)));
  }
}

class RefusingBuilder implements HarnessModuleMapBuilder {
  build(harnessCommit: string): Promise<HarnessBuildResult> {
    return Promise.resolve(
      Result.err({ code: "build-step-failed", harnessCommit, step: "build-pi", exitCode: 2 }),
    );
  }
}

/** Real storage that refuses every chunk, which is how a store write fails without a platform. */
function refusingStorage(storage: DurableObjectStorage): ModuleMapStorage {
  return {
    sql: {
      exec: <T extends Record<string, SqlStorageValue>>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursor<T> => {
        if (query.includes("INSERT INTO module_map_chunks")) {
          throw new Error("the storage refused a chunk");
        }

        return storage.sql.exec<T>(query, ...bindings);
      },
    },
    transactionSync: (operation) => storage.transactionSync(operation),
  };
}

function commit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);

  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("builds, validates, stores, then loads a module map when nothing is stored", async () => {
  const control = supervisor("prepare-builds-and-stores");
  const builder = new CountingBuilder();

  const prepared = await runInDurableObject(control, async (_instance, state) => {
    const moduleMap = await new HarnessArtifacts(state.storage, builder).prepare(commits.built);

    if (moduleMap.isErr()) {
      throw new Error(`a successful build must prepare: ${moduleMap.error.code}`);
    }

    const stored = new ModuleMapStore(state.storage).read(commit(commits.built));

    return {
      moduleMap: moduleMap.value,
      storedSameBytes:
        stored.isOk() &&
        stored.value.kind === "stored" &&
        encodeModuleMap(stored.value.moduleMap) === encodeModuleMap(moduleMap.value),
    };
  });

  expect(builder.builds).toBe(1);
  expect(prepared.storedSameBytes, "a prepared commit is stored before it is returned").toBe(true);
  // Canonical form: the entry module is named, and every module is sorted by name.
  expect(prepared.moduleMap.modules.map((module) => module.name)).toEqual(["body.js", "main.js"]);

  const loaded = loadMainFacet(env.LOADER, prepared.moduleMap, { MODEL: modelRoute });

  if (loaded.isErr()) {
    throw new Error(`the built module map must load: ${loaded.error.code}`);
  }

  const response = await loaded.value.worker.getEntrypoint().fetch("https://main-facet.invalid/");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("built module map");
});

test("prepares a stored module map without rebuilding it", async () => {
  const control = supervisor("prepare-reads-stored-module-map");
  const builder = new CountingBuilder();

  const prepared = await runInDurableObject(control, async (_instance, state) => {
    const first = await new HarnessArtifacts(state.storage, builder).prepare(commits.stored);

    // A second preparation with no build workspace: only the store can answer this one.
    const second = await new HarnessArtifacts(state.storage, absentModuleMapBuilder).prepare(
      commits.stored,
    );

    if (first.isErr() || second.isErr()) {
      throw new Error("a stored module map must prepare twice");
    }

    return {
      first: encodeModuleMap(first.value),
      second: encodeModuleMap(second.value),
    };
  });

  expect(builder.builds).toBe(1);
  expect(prepared.second).toBe(prepared.first);
});

test("reports a failed build and stores nothing", async () => {
  const control = supervisor("prepare-reports-failed-build");

  const outcome = await runInDurableObject(control, async (_instance, state) => {
    const prepared = await new HarnessArtifacts(state.storage, new RefusingBuilder()).prepare(
      commits.failed,
    );

    return {
      problem: prepared.isErr() ? prepared.error : undefined,
      rows: state.storage.sql
        .exec<{ readonly n: number }>(
          "SELECT COUNT(*) AS n FROM module_map_manifests WHERE harness_commit = ?",
          commits.failed,
        )
        .one().n,
    };
  });

  expect(outcome.problem).toEqual({
    code: "build-step-failed",
    harnessCommit: commits.failed,
    step: "build-pi",
    exitCode: 2,
  });
  expect(outcome.rows).toBe(0);
});

/**
 * The old resolver returned a built map with `cacheWrite: "failed"` and let startup continue.
 * Rollback cannot rebuild any more, so a generation must not become ready on a map that is not
 * stored: the write failure is the preparation's failure.
 */
test("fails preparation when the store refuses the write", async () => {
  const control = supervisor("prepare-fails-on-unstorable-map");

  const problem = await runInDurableObject(control, async (_instance, state) => {
    const prepared = await new HarnessArtifacts(
      refusingStorage(state.storage),
      new CountingBuilder(),
    ).prepare(commits.unstorable);

    return prepared.isErr() ? prepared.error : undefined;
  });

  expect(problem).toEqual({
    code: "artifact-write-failed",
    harnessCommit: commits.unstorable,
  });
});

test("refuses a commit that is not a harness commit without building", async () => {
  const control = supervisor("prepare-refuses-invalid-commit");
  const builder = new CountingBuilder();

  const problem = await runInDurableObject(control, async (_instance, state) => {
    const prepared = await new HarnessArtifacts(state.storage, builder).prepare(commits.invalid);

    return prepared.isErr() ? prepared.error : undefined;
  });

  expect(problem).toEqual({ code: "invalid-harness-commit", harnessCommit: commits.invalid });
  expect(builder.builds).toBe(0);
});
