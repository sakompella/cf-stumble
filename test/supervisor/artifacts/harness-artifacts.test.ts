import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
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

function supervisor(name: string) {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("builds, stores, then loads a module map when nothing is stored", async () => {
  const control = supervisor("prepare-builds-and-stores");
  const host = new BuildHost();

  const prepared = await runInDurableObject(control, async (_instance, state) => {
    const artifact = await resultOf(
      new HarnessArtifacts(state.storage, () => host).prepare(commits.built),
    );

    if (Result.isFailure(artifact)) {
      throw new Error(`a successful build must prepare: ${artifact.failure.code}`);
    }

    const stored = new ModuleMapStore(state.storage).read(commits.built);

    return {
      artifact: artifact.success,
      storedSameBytes:
        Result.isSuccess(stored) &&
        stored.success.kind === "stored" &&
        encodeModuleMap(stored.success.artifact) === encodeModuleMap(artifact.success),
    };
  });

  expect(host.builds()).toBe(1);
  expect(prepared.storedSameBytes, "a prepared commit is stored before it is returned").toBe(true);

  const loaded = loadMainFacet(env.LOADER, prepared.artifact, { MODEL: modelRoute });
  const response = await loaded.worker.getEntrypoint().fetch("https://main-facet.invalid/");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("built module map");
});

test("prepares a stored module map without rebuilding it", async () => {
  const control = supervisor("prepare-reads-stored-module-map");
  const host = new BuildHost();

  const prepared = await runInDurableObject(control, async (_instance, state) => {
    const first = await resultOf(
      new HarnessArtifacts(state.storage, () => host).prepare(commits.stored),
    );

    const second = await resultOf(
      new HarnessArtifacts(state.storage, () => unreachableHost).prepare(commits.stored),
    );

    if (Result.isFailure(first) || Result.isFailure(second)) {
      throw new Error("a stored module map must prepare twice");
    }

    return {
      first: encodeModuleMap(first.success),
      second: encodeModuleMap(second.success),
    };
  });

  expect(host.builds()).toBe(1);
  expect(prepared.second).toBe(prepared.first);
});

test("reports a failed build and stores nothing", async () => {
  const control = supervisor("prepare-reports-failed-build");
  const host = new BuildHost();
  host.failing = "build-module-map";

  const outcome = await runInDurableObject(control, async (_instance, state) => {
    const prepared = await resultOf(
      new HarnessArtifacts(state.storage, () => host).prepare(commits.failed),
    );

    return {
      problem: Result.isFailure(prepared) ? prepared.failure : undefined,
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
    step: "build-module-map",
    exitCode: 2,
    diagnostics: { stdoutTail: "", stderrTail: "", truncated: false },
  });
  expect(outcome.rows).toBe(0);
});
