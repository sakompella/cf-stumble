/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { MainHarnessArtifact } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
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
} as const;

/**
 * A module map whose canonical encoding needs several chunks, filled with a three-byte character
 * so a chunk boundary falls inside one character. Reading it back proves the store splits bytes
 * and not text.
 */
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

function commit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

function parsedArtifact(input: MainHarnessArtifactInput): MainHarnessArtifact {
  const artifactValue = MainHarnessArtifact.parse(input);
  if (artifactValue.isErr()) {
    throw new Error(`the test module map must parse: ${artifactValue.error.code}`);
  }

  return artifactValue.value;
}

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

/**
 * Real Durable Object storage with one refusing statement. The store's write is one
 * `transactionSync`, so refusing the second chunk insert aborts a write that had already stored
 * the manifest and the first chunk.
 */
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
            throw new Error("the storage refused a chunk");
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
    const found = new ModuleMapStore(state.storage).read(commit(harnessCommit));
    return found.isErr() ? `problem:${found.error.code}` : found.value.kind;
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
    const read = new ModuleMapStore(state.storage).read(commit(commits.evicted));
    if (read.isErr() || read.value.kind === "absent") {
      throw new Error("an evicted Supervisor must still hold its stored module map");
    }

    return encodeModuleMap(read.value.moduleMap);
  });

  expect(found).toBe(encodeModuleMap(input));
});

test("stores a module map larger than one chunk and reads back the same bytes", async () => {
  const control = supervisor("module-map-larger-than-one-chunk");
  const input = largeModuleMap(commits.large);

  const stored = await runInDurableObject(control, (_instance, state) => {
    const store = new ModuleMapStore(state.storage);
    const written = store.write(parsedArtifact(input));
    if (written.isErr()) {
      throw new Error(`a large module map must be written: ${written.error.code}`);
    }

    const read = store.read(commit(commits.large));
    if (read.isErr() || read.value.kind === "absent") {
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
      sameBytes: encodeModuleMap(read.value.moduleMap) === encodeModuleMap(written.value),
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
    const read = store.read(commit(commits.atomic));

    return {
      write: written.isErr() ? written.error.code : "written",
      read: read.isErr() ? `problem:${read.error.code}` : read.value.kind,
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

test("reports an incomplete stored module map instead of rebuilding the commit", async () => {
  const control = await activeSupervisor("incomplete-module-map-fails-closed");
  const input = largeModuleMap(commits.incomplete);
  await storeModuleMap(control, input);
  // The manifest still counts two chunks, so this leaves the count right and the indexes wrong.
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
  expect(await control.getGeneration(label)).toMatchObject({ label, status: "candidate" });
});

/**
 * Demo step 7. The Supervisor's builder is the Workspace Host builder, and this runtime has no
 * container to start, so every build here fails. The rollback still serves, which is the property
 * the demo needs: a generation that is ready has its module map stored, and nothing rebuilds it.
 */
test("rolls back to a stored generation while every build fails", async () => {
  const control = await activeSupervisor("rollback-loads-stored-module-map");
  const secondCommit = commits.rolledForward;
  await storeModuleMap(
    control,
    artifact(
      secondCommit,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Response("second generation serving"); }
}
`,
    ),
  );
  const second = await submitCandidate(control, secondCommit);
  const preparedSecond = await control.prepareGeneration(second);
  expect(preparedSecond).toMatchObject({ ok: true, report: { stage: "ready" } });
  await activateGeneration(control, second);
  expect(await (await control.fetch(new Request("https://cf-stumble.test/"))).text()).toBe(
    "second generation serving",
  );

  await evictDurableObject(control);
  const active = await control.getActiveGeneration();
  const rolledBack = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "rollback", label: 0, observedEpoch: active.epoch },
  });
  const response = await control.fetch(new Request("https://cf-stumble.test/facet/ping"));

  expect(rolledBack).toMatchObject({ ok: true, outcome: { kind: "rolled-back" } });
  expect(await response.text()).toBe("pong");
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
