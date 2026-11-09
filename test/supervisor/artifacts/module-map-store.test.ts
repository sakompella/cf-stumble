import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Result from "effect/Result";
import { ModuleMapStore } from "../../../src/supervisor/artifacts/index.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { migrateModuleMaps } from "../../../src/supervisor/artifacts/migrate.js";
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
  immutable: "7100000000000000000000000000000000000007",
  migrated: "7100000000000000000000000000000000000008",
} as const;

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function refusingPut(bucket: R2Bucket): R2Bucket {
  return {
    ...bucket,
    put: () => Promise.reject(new Error(`the bucket refused a write ghp_${"a".repeat(36)}`)),
  };
}

afterEach(async () => {
  await reset();
});

test("keeps a stored module map across a Durable Object eviction", async () => {
  const control = supervisor("stored-module-map-survives-eviction");
  const input = artifact(commits.evicted, 'export const body = "stored across eviction";\n');
  await storeModuleMap(input);
  await control.getActiveGeneration();

  await evictDurableObject(control);

  const read = await new ModuleMapStore(env.MODULE_MAPS).read(testHarnessCommit(commits.evicted));

  if (Result.isFailure(read) || read.success.kind === "absent") {
    throw new Error("an evicted Supervisor must still find its stored module map");
  }

  expect(encodeModuleMap(read.success.artifact)).toBe(encodeModuleMap(parsedArtifact(input)));
});

test("stores a large module map under its commit key and reads back the same bytes", async () => {
  const store = new ModuleMapStore(env.MODULE_MAPS);
  const written = await store.write(parsedArtifact(largeModuleMap(commits.large)));

  if (Result.isFailure(written)) {
    throw new Error(`a large module map must be written: ${written.failure.code}`);
  }

  const read = await store.read(testHarnessCommit(commits.large));
  const object = await env.MODULE_MAPS.get(`module-maps/${commits.large}.json`);

  if (Result.isFailure(read) || read.success.kind === "absent") {
    throw new Error("a large module map must read back");
  }

  expect(await object?.text()).toBe(encodeModuleMap(written.success));
  expect(encodeModuleMap(read.success.artifact)).toBe(encodeModuleMap(written.success));
});

test("never overwrites a stored module map", async () => {
  const store = new ModuleMapStore(env.MODULE_MAPS);
  await store.write(parsedArtifact(artifact(commits.immutable, "export const first = 1;\n")));
  await store.write(parsedArtifact(artifact(commits.immutable, "export const second = 2;\n")));

  const read = await store.read(testHarnessCommit(commits.immutable));

  expect(
    Result.isSuccess(read) && read.success.kind === "stored"
      ? read.success.artifact.modules[0].source
      : "",
  ).toBe("export const first = 1;\n");
});

test("a refused write reports a problem and stores nothing", async () => {
  const written = await new ModuleMapStore(refusingPut(env.MODULE_MAPS)).write(
    parsedArtifact(largeModuleMap(commits.atomic)),
  );

  const read = await new ModuleMapStore(env.MODULE_MAPS).read(testHarnessCommit(commits.atomic));

  expect(Result.isFailure(written) ? written.failure.code : "written").toBe(
    "artifact-write-failed",
  );
  expect(Result.isSuccess(read) ? read.success.kind : "problem").toBe("absent");
});

test("copies module maps from the old SQLite tables to R2 and drops the tables", async () => {
  const control = supervisor("module-map-migration");
  const input = largeModuleMap(commits.migrated);
  const expected = encodeModuleMap(parsedArtifact(input));
  const bytes = new TextEncoder().encode(expected);
  const split = Math.floor(bytes.byteLength / 2);

  const remaining = await runInDurableObject(control, async (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TABLE module_map_manifests (harness_commit TEXT PRIMARY KEY, chunk_count INTEGER, byte_count INTEGER);
       CREATE TABLE module_map_chunks (harness_commit TEXT, chunk_index INTEGER, bytes BLOB, PRIMARY KEY (harness_commit, chunk_index))`,
    );
    state.storage.sql.exec(
      "INSERT INTO module_map_manifests VALUES (?, 2, ?)",
      commits.migrated,
      bytes.byteLength,
    );
    state.storage.sql.exec(
      "INSERT INTO module_map_chunks VALUES (?, 0, ?)",
      commits.migrated,
      bytes.slice(0, split),
    );
    state.storage.sql.exec(
      "INSERT INTO module_map_chunks VALUES (?, 1, ?)",
      commits.migrated,
      bytes.slice(split),
    );

    await migrateModuleMaps(state.storage.sql, env.MODULE_MAPS);

    return state.storage.sql
      .exec<{ readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE name LIKE 'module_map_%'",
      )
      .toArray();
  });

  expect(remaining).toEqual([]);
  expect(await (await env.MODULE_MAPS.get(`module-maps/${commits.migrated}.json`))?.text()).toBe(
    expected,
  );
});

test("rolls back to a stored generation while every build fails", async () => {
  const control = await activeSupervisor("rollback-loads-stored-module-map");
  const secondCommit = commits.rolledForward;
  await storeModuleMap(artifact(secondCommit, servingFacetSource("second generation serving")));
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
