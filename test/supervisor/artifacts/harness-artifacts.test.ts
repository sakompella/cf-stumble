import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { loadMainFacet } from "../../../src/facet/index.js";
import { HarnessArtifacts, ModuleMapStore } from "../../../src/supervisor/artifacts/index.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { BuildHost, unreachableHost } from "./build-hosts.js";
import { generationLabel, readyArtifact, storeModuleMap, testHarnessCommit } from "../helpers.js";

const modelRoute = workerExports.ModelRoute({});

const commits = {
  built: testHarnessCommit("1000000000000000000000000000000000000001"),
  stored: testHarnessCommit("1000000000000000000000000000000000000002"),
  failed: testHarnessCommit("1000000000000000000000000000000000000004"),
  absent: testHarnessCommit("1000000000000000000000000000000000000005"),
  a: testHarnessCommit("1000000000000000000000000000000000000006"),
  b: testHarnessCommit("1000000000000000000000000000000000000007"),
  c: testHarnessCommit("1000000000000000000000000000000000000008"),
} as const;

type Commit = (typeof commits)[keyof typeof commits];

function countingBucket() {
  const reads = new Map<string, number>();

  const bucket: R2Bucket = {
    ...env.MODULE_MAPS,
    get(key: string) {
      reads.set(key, (reads.get(key) ?? 0) + 1);

      return env.MODULE_MAPS.get(key);
    },
    put: (key, value, options) => env.MODULE_MAPS.put(key, value, options),
  };

  return {
    bucket,
    reads: (harnessCommit: Commit) => reads.get(`module-maps/${harnessCommit}.json`) ?? 0,
  };
}

function mounted(artifacts: HarnessArtifacts, harnessCommit: Commit): Promise<string> {
  const active = {
    generation: { label: generationLabel(1), harnessCommit, status: "ready" },
    epoch: 1,
  } as const;

  return runInDurableObject(
    env.SUPERVISOR.getByName("harness-artifacts-mount"),
    async (_instance, state) => {
      const facet = await resultOf(
        artifacts.mount(active, env.LOADER, state.facets, () => workerExports.ModelRoute({}), 0),
      );

      return Result.isSuccess(facet) ? "mounted" : facet.failure.code;
    },
  );
}

afterEach(async () => {
  await reset();
});

test("builds, stores in R2, then loads a module map when nothing is stored", async () => {
  const host = new BuildHost();

  const artifact = await resultOf(
    new HarnessArtifacts(env.MODULE_MAPS, () => host).prepare(commits.built),
  );

  if (Result.isFailure(artifact)) {
    throw new Error(`a successful build must prepare: ${artifact.failure.code}`);
  }

  const stored = await new ModuleMapStore(env.MODULE_MAPS).read(commits.built);
  const object = await env.MODULE_MAPS.get(`module-maps/${commits.built}.json`);

  expect(host.builds()).toBe(1);
  expect(await object?.text(), "a prepared commit is stored in R2 before it is returned").toBe(
    encodeModuleMap(artifact.success),
  );
  expect(Result.isSuccess(stored) && stored.success.kind).toBe("stored");

  const loaded = loadMainFacet(env.LOADER, artifact.success, { MODEL: modelRoute });
  const response = await loaded.worker.getEntrypoint().fetch("https://main-facet.invalid/");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("built module map");
});

test("prepares a stored module map without rebuilding it", async () => {
  const host = new BuildHost();

  const first = await resultOf(
    new HarnessArtifacts(env.MODULE_MAPS, () => host).prepare(commits.stored),
  );

  const second = await resultOf(
    new HarnessArtifacts(env.MODULE_MAPS, () => unreachableHost).prepare(commits.stored),
  );

  if (Result.isFailure(first) || Result.isFailure(second)) {
    throw new Error("a stored module map must prepare twice");
  }

  expect(host.builds()).toBe(1);
  expect(encodeModuleMap(second.success)).toBe(encodeModuleMap(first.success));
});

test("reports a failed build and stores nothing", async () => {
  const host = new BuildHost();
  host.failing = "build-module-map";

  const prepared = await resultOf(
    new HarnessArtifacts(env.MODULE_MAPS, () => host).prepare(commits.failed),
  );

  expect(Result.isFailure(prepared) ? prepared.failure : undefined).toEqual({
    code: "build-step-failed",
    harnessCommit: commits.failed,
    step: "build-module-map",
    exitCode: 2,
    diagnostics: { stdoutTail: "", stderrTail: "", truncated: false },
  });
  expect(await env.MODULE_MAPS.get(`module-maps/${commits.failed}.json`)).toBeNull();
});

test("mounting one stored commit twice reads R2 once", async () => {
  await storeModuleMap(readyArtifact(commits.stored));
  const { bucket, reads } = countingBucket();
  const artifacts = new HarnessArtifacts(bucket, () => unreachableHost);

  expect(await mounted(artifacts, commits.stored)).toBe("mounted");
  expect(await mounted(artifacts, commits.stored)).toBe("mounted");
  expect(reads(commits.stored)).toBe(1);
});

test("an absent module map is read again on the next mount", async () => {
  const { bucket, reads } = countingBucket();
  const artifacts = new HarnessArtifacts(bucket, () => unreachableHost);

  expect(await mounted(artifacts, commits.absent)).toBe("stored-module-map-absent");
  expect(await mounted(artifacts, commits.absent)).toBe("stored-module-map-absent");

  await storeModuleMap(readyArtifact(commits.absent));

  expect(await mounted(artifacts, commits.absent)).toBe("mounted");
  expect(reads(commits.absent)).toBe(3);
});

test("a commit that prepare built mounts without reading R2 again", async () => {
  const { bucket, reads } = countingBucket();
  const artifacts = new HarnessArtifacts(bucket, () => new BuildHost());

  expect(Result.isSuccess(await resultOf(artifacts.prepare(commits.built)))).toBe(true);
  expect(reads(commits.built), "prepare reads once to find the map absent").toBe(1);

  expect(await mounted(artifacts, commits.built)).toBe("mounted");
  expect(reads(commits.built)).toBe(1);
});

test("keeps the two most recently used module maps", async () => {
  for (const commit of [commits.a, commits.b, commits.c]) {
    await storeModuleMap(readyArtifact(commit));
  }

  const { bucket, reads } = countingBucket();
  const artifacts = new HarnessArtifacts(bucket, () => unreachableHost);

  for (const commit of [commits.a, commits.b, commits.a, commits.c, commits.a]) {
    expect(await mounted(artifacts, commit)).toBe("mounted");
  }

  expect(reads(commits.a)).toBe(1);

  expect(await mounted(artifacts, commits.b)).toBe("mounted");
  expect(reads(commits.b)).toBe(2);
});
