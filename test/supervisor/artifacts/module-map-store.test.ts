import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { containsCredential } from "../../../src/github/index.js";
import {
  encodeModuleMap,
  MODULE_MAP_CHUNK_BYTES,
  ModuleMapStore,
} from "../../../src/supervisor/artifacts/index.js";
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
} from "../helpers.js";

const commits = {
  evicted: "7100000000000000000000000000000000000001",
  atomic: "7100000000000000000000000000000000000002",
  large: "7100000000000000000000000000000000000003",
  incomplete: "7100000000000000000000000000000000000004",
  rolledForward: "7100000000000000000000000000000000000005",
  unbuildable: "7100000000000000000000000000000000000006",
  loggedFailure: "7100000000000000000000000000000000000007",
} as const;

function largeModuleMap(harnessCommit: string): MainHarnessArtifactInput {
  const filler = "\u2603".repeat(200_000);

  return {
    harnessCommit,
    entryModule: "main.js",
    modules: [
      { name: "main.js", source: `export const snowman = "${filler}";\n` },
      { name: "helper.js", source: `export const helper = "${filler}";\n` },
    ],
  };
}

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

function storedKind(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<string> {
  return runInDurableObject(control, (_instance, state) => {
    const found = new ModuleMapStore(state.storage).read(testHarnessCommit(harnessCommit));

    return Result.isFailure(found) ? `problem:${found.failure.code}` : found.success.kind;
  });
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

afterEach(() => {
  vi.restoreAllMocks();
});

test("logs a redacted cause instead of discarding it when the transaction throws", async () => {
  const control = supervisor("module-map-write-logs-its-cause");
  const input = largeModuleMap(commits.loggedFailure);
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const outcome = await runInDurableObject(control, (_instance, state) => {
    const written = new ModuleMapStore(refusingSecondChunk(state.storage)).write(
      parsedArtifact(input),
    );

    return Result.isFailure(written) ? written.failure.code : "written";
  });

  expect(outcome).toBe("artifact-write-failed");
  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("artifact-write-failed");
  expect(logged).toContain("the storage refused a chunk");
  expect(containsCredential(logged), "the operator log must redact token-shaped causes").toBe(
    false,
  );
});

test("reports an incomplete stored module map instead of rebuilding the commit", async () => {
  const control = await activeSupervisor("incomplete-module-map-fails-closed");
  const input = largeModuleMap(commits.incomplete);
  await storeModuleMap(control, input);
  await runInDurableObject(control, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE module_map_chunks SET chunk_index = 5 WHERE harness_commit = ? AND chunk_index = 1",
      commits.incomplete,
    );
  });
  const label = await submitCandidate(control, commits.incomplete);

  const prepared = await control.prepareGeneration(label);

  expect(
    prepared,
    "a damaged row set is reported, not rebuilt: a build failure would say so instead",
  ).toEqual({
    ok: false,
    problem: { code: "stored-module-map-incomplete", harnessCommit: commits.incomplete },
  });
  await expect(storedKind(control, commits.incomplete)).resolves.toBe(
    "problem:stored-module-map-incomplete",
  );
});

test("rolls back to a stored generation while every build fails", async () => {
  const control = await activeSupervisor("rollback-loads-stored-module-map");
  const secondCommit = commits.rolledForward;
  await storeModuleMap(
    control,
    artifact(secondCommit, servingFacetSource("second generation serving")),
  );
  const second = await submitCandidate(control, secondCommit);
  const preparedSecond = await control.prepareGeneration(second);
  expect(preparedSecond).toMatchObject({ ok: true, report: { stage: "ready" } });
  await activateGeneration(control, second);
  expect(await servedText(control)).toBe("second generation serving");

  await evictDurableObject(control);
  const active = await control.getActiveGeneration();

  const rolledBack = await control.controlGeneration({
    kind: "rollback",
    label: 0,
    observedEpoch: active.epoch,
  });

  expect(rolledBack).toMatchObject({ ok: true, outcome: { kind: "rolled-back" } });
  expect(await servedText(control)).toBe(fixtureMainHarnessCommit);

  const unbuildable = await control.prepareGeneration(
    await submitCandidate(control, commits.unbuildable),
  );

  expect(
    unbuildable,
    "the rollback above served with a builder that cannot build anything",
  ).toEqual({
    ok: false,
    problem: { code: "build-workspace-unavailable", harnessCommit: commits.unbuildable },
  });
});
