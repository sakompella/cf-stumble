import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Result from "effect/Result";
import { ModuleMapStore } from "../../../src/supervisor/artifacts/index.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { MODULE_MAP_CHUNK_BYTES } from "../../../src/supervisor/artifacts/store.js";
import type { ModuleMapStorage } from "../../../src/supervisor/artifacts/index.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  activeSupervisor,
  artifact,
  fixtureMainHarnessCommit,
  parsedArtifact,
  servedText,
  servingFacetSource,
  storeModuleMap,
  submitCandidate,
  generationLabel,
  largeModuleMap,
  testHarnessCommit,
} from "../helpers.js";

const commits = {
  evicted: "7100000000000000000000000000000000000001",
  atomic: "7100000000000000000000000000000000000002",
  large: "7100000000000000000000000000000000000003",
  rolledForward: "7100000000000000000000000000000000000005",
  unbuildable: "7100000000000000000000000000000000000006",
} as const;

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function refusingSecondChunk(storage: DurableObjectStorage): ModuleMapStorage {
  let chunkWrites = 0;

  return {
    sql: {
      exec: <T extends Record<string, SqlStorageValue>>(
        query: string,
        ...bindings: unknown[]
      ): SqlStorageCursor<T> => {
        if (query.includes("INSERT INTO module_map_chunks")) {
          chunkWrites += 1;

          if (chunkWrites > 1) {
            throw new Error(`the storage refused a chunk ghp_${"a".repeat(36)}`);
          }
        }

        return storage.sql.exec<T>(query, ...bindings);
      },
    },
    transactionSync: (operation) => storage.transactionSync(operation),
  };
}

afterEach(async () => {
  await reset();
});

test("keeps a stored module map across a Durable Object eviction", async () => {
  const control = supervisor("stored-module-map-survives-eviction");
  const input = artifact(commits.evicted, 'export const body = "stored across eviction";\n');
  await storeModuleMap(control, input);

  await evictDurableObject(control);

  const found = await runInDurableObject(control, (_instance, state) => {
    const read = new ModuleMapStore(state.storage).read(testHarnessCommit(commits.evicted));

    if (Result.isFailure(read) || read.success.kind === "absent") {
      throw new Error("an evicted Supervisor must still hold its stored module map");
    }

    return encodeModuleMap(read.success.artifact);
  });

  expect(found).toBe(encodeModuleMap(parsedArtifact(input)));
});

test("stores a module map larger than one chunk and reads back the same bytes", async () => {
  const control = supervisor("module-map-larger-than-one-chunk");
  const input = largeModuleMap(commits.large);

  const stored = await runInDurableObject(control, (_instance, state) => {
    const store = new ModuleMapStore(state.storage);
    const written = store.write(parsedArtifact(input));

    if (Result.isFailure(written)) {
      throw new Error(`a large module map must be written: ${written.failure.code}`);
    }

    const read = store.read(testHarnessCommit(commits.large));

    if (Result.isFailure(read) || read.success.kind === "absent") {
      throw new Error("a large module map must read back");
    }

    return {
      chunkSizes: state.storage.sql
        .exec<{ readonly size: number }>(
          "SELECT LENGTH(bytes) AS size FROM module_map_chunks WHERE harness_commit = ? ORDER BY chunk_index ASC",
          commits.large,
        )
        .toArray()
        .map((row) => row.size),
      manifest: state.storage.sql
        .exec<{ readonly chunk_count: number; readonly byte_count: number }>(
          "SELECT chunk_count, byte_count FROM module_map_manifests WHERE harness_commit = ?",
          commits.large,
        )
        .one(),
      sameBytes: encodeModuleMap(read.success.artifact) === encodeModuleMap(written.success),
    };
  });

  expect(stored.chunkSizes.length).toBeGreaterThan(1);
  expect(stored.chunkSizes.length).toBe(stored.manifest.chunk_count);
  expect(
    Math.max(...stored.chunkSizes),
    "no row may approach the 2 MB Durable Object row limit",
  ).toBeLessThanOrEqual(MODULE_MAP_CHUNK_BYTES);
  expect(stored.chunkSizes.reduce((total, size) => total + size, 0)).toBe(
    stored.manifest.byte_count,
  );
  expect(stored.sameBytes, "a chunk boundary inside a character must not change the map").toBe(
    true,
  );
});

test("a write that fails part way through leaves no partial module map", async () => {
  const control = supervisor("module-map-write-is-atomic");
  const input = largeModuleMap(commits.atomic);

  const outcome = await runInDurableObject(control, (_instance, state) => {
    const written = new ModuleMapStore(refusingSecondChunk(state.storage)).write(
      parsedArtifact(input),
    );

    const store = new ModuleMapStore(state.storage);
    const read = store.read(testHarnessCommit(commits.atomic));

    return {
      write: Result.isFailure(written) ? written.failure.code : "written",
      read: Result.isFailure(read) ? `problem:${read.failure.code}` : read.success.kind,
      rows: state.storage.sql
        .exec<{ readonly manifests: number; readonly chunks: number }>(
          `SELECT
             (SELECT COUNT(*) FROM module_map_manifests WHERE harness_commit = ?) AS manifests,
             (SELECT COUNT(*) FROM module_map_chunks WHERE harness_commit = ?) AS chunks`,
          commits.atomic,
          commits.atomic,
        )
        .one(),
    };
  });

  expect(outcome).toEqual({
    write: "artifact-write-failed",
    read: "absent",
    rows: { manifests: 0, chunks: 0 },
  });
});

test("rolls back to a stored generation while every build fails", async () => {
  const control = await activeSupervisor("rollback-loads-stored-module-map");
  const secondCommit = commits.rolledForward;
  await storeModuleMap(
    control,
    artifact(secondCommit, servingFacetSource("second generation serving")),
  );
  const second = await submitCandidate(control, secondCommit);
  const preparedSecond = await control.prepareGeneration(generationLabel(second));
  expect(preparedSecond).toMatchObject({ ok: true, report: { stage: "ready" } });
  await activateGeneration(control, second);
  expect(await servedText(control)).toBe("second generation serving");

  await evictDurableObject(control);
  const active = await control.getActiveGeneration();

  const rolledBack = await control.controlGeneration({
    kind: "rollback",
    label: generationLabel(0),
    observedEpoch: active.epoch,
  });

  expect(rolledBack).toMatchObject({ ok: true, outcome: { kind: "rolled-back" } });
  expect(await servedText(control)).toBe(fixtureMainHarnessCommit);

  const unbuildable = await control.prepareGeneration(
    generationLabel(await submitCandidate(control, commits.unbuildable)),
  );

  expect(
    unbuildable,
    "the rollback above served with a builder that cannot build anything",
  ).toEqual({
    ok: false,
    problem: { code: "build-workspace-unavailable", harnessCommit: commits.unbuildable },
  });
});
