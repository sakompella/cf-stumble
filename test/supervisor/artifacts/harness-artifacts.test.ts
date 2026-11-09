import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { loadMainFacet } from "../../../src/facet/index.js";
import { HarnessArtifacts, ModuleMapStore } from "../../../src/supervisor/artifacts/index.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { BuildHost, unreachableHost } from "./build-hosts.js";

const modelRoute = workerExports.ModelRoute({});

const commits = {
  built: testHarnessCommit("1000000000000000000000000000000000000001"),
  stored: testHarnessCommit("1000000000000000000000000000000000000002"),
  failed: testHarnessCommit("1000000000000000000000000000000000000004"),
} as const;

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
