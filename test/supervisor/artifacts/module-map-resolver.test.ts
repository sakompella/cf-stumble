/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { Result } from "better-result";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { parseHarnessCommit } from "../../../src/harness-commit.js";
import {
  absentModuleMapBuilder,
  encodeModuleMap,
  ModuleMapCache,
  resolveModuleMap,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  HarnessBuildResult,
  HarnessModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";

const modelRoute = workerExports.ModelRoute({});

const commits = {
  miss: "1000000000000000000000000000000000000001",
  hit: "1000000000000000000000000000000000000002",
  corrupt: "1000000000000000000000000000000000000003",
  failed: "1000000000000000000000000000000000000004",
} as const;

function harnessCommit(value: string) {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

function builtModuleMap(commit: string): MainHarnessArtifactInput {
  return {
    harnessCommit: commit,
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

  build(commit: string): Promise<HarnessBuildResult> {
    this.builds += 1;
    return Promise.resolve(Result.ok(builtModuleMap(commit)));
  }
}

class RefusingBuilder implements HarnessModuleMapBuilder {
  build(commit: string): Promise<HarnessBuildResult> {
    return Promise.resolve(
      Result.err({ code: "build-step-failed", harnessCommit: commit, step: "build", exitCode: 2 }),
    );
  }
}

function cache(): ModuleMapCache {
  return new ModuleMapCache(env.MODULE_MAPS);
}

async function cachedText(commit: string): Promise<string> {
  const object = await env.MODULE_MAPS.get(`module-maps/${commit}`);
  if (object === null) {
    throw new Error("the cached module map must be readable");
  }

  return object.text();
}

afterEach(async () => {
  await reset();
});

test("builds, validates, caches, then loads a module map on a cache miss", async () => {
  const builder = new CountingBuilder();

  const resolved = await resolveModuleMap(cache(), builder, harnessCommit(commits.miss));

  if (resolved.isErr()) {
    throw new Error(`a successful build must resolve: ${resolved.error.code}`);
  }
  expect(resolved.value).toMatchObject({ source: "build", cacheWrite: "written" });
  expect(builder.builds).toBe(1);
  // Canonical form: the entry module is named, and every module is sorted by name.
  expect(resolved.value.moduleMap.modules.map((module) => module.name)).toEqual([
    "body.js",
    "main.js",
  ]);
  expect(await cachedText(commits.miss)).toBe(encodeModuleMap(resolved.value.moduleMap));

  const loaded = loadMainFacet(env.LOADER, resolved.value.moduleMap, { MODEL: modelRoute });
  if (loaded.isErr()) {
    throw new Error(`the built module map must load: ${loaded.error.code}`);
  }
  const response = await loaded.value.worker.getEntrypoint().fetch("https://main-facet.invalid/");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("built module map");
});

test("loads a cached module map without rebuilding it", async () => {
  const builder = new CountingBuilder();
  const first = await resolveModuleMap(cache(), builder, harnessCommit(commits.hit));

  // A cold resolver with no build workspace: only the cache can answer this one.
  const second = await resolveModuleMap(
    cache(),
    absentModuleMapBuilder,
    harnessCommit(commits.hit),
  );

  if (first.isErr() || second.isErr()) {
    throw new Error("a cached module map must resolve twice");
  }
  expect(first.value.source).toBe("build");
  expect(second.value.source).toBe("cache");
  expect(builder.builds).toBe(1);
  expect(second.value.moduleMap).toEqual(first.value.moduleMap);
});

test("rejects a corrupt cached object and rebuilds the commit", async () => {
  await env.MODULE_MAPS.put(`module-maps/${commits.corrupt}`, "not-json");
  const builder = new CountingBuilder();

  const resolved = await resolveModuleMap(cache(), builder, harnessCommit(commits.corrupt));

  if (resolved.isErr()) {
    throw new Error(`a corrupt object must be rebuilt: ${resolved.error.code}`);
  }
  expect(resolved.value.source).toBe("build");
  expect(builder.builds).toBe(1);
  expect(await cachedText(commits.corrupt)).toBe(encodeModuleMap(resolved.value.moduleMap));
});

test("reports a failed build and caches nothing", async () => {
  const resolved = await resolveModuleMap(
    cache(),
    new RefusingBuilder(),
    harnessCommit(commits.failed),
  );

  expect(resolved.isErr()).toBe(true);
  if (resolved.isOk()) {
    throw new Error("a failed build must not resolve a module map");
  }
  expect(resolved.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commits.failed,
    step: "build",
    exitCode: 2,
  });
  expect(await env.MODULE_MAPS.get(`module-maps/${commits.failed}`)).toBeNull();
});
