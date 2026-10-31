import { expect, test } from "vitest";
import * as Effect from "effect/Effect";
import { HARNESS_BUILD_STEP_NAMES } from "../../../src/harness-build.js";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { namespaceFor } from "../../workspace-namespace-fixture.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  encodeModuleMap,
  WorkspaceHostModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { HarnessBuildRequest } from "../../../src/harness-build.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";

const commit = testHarnessCommit("6000000000000000000000000000000000000002");

const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");

const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

function moduleMapFile(): string {
  return JSON.stringify({ entryModule: "main.js", modules: [helperModule, entryModule] });
}

class CountingBuildHost implements BuildWorkspaceHost {
  readonly requests: HarnessBuildRequest[] = [];

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.requests.push(request);

    if (request.kind === "build-output") {
      return Promise.resolve({
        ok: true,
        result: { kind: "command", stdout: moduleMapFile(), stderr: "", exitCode: 0 },
      });
    }

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }
}

class GatedBuildHost implements BuildWorkspaceHost {
  readonly inner = new CountingBuildHost();
  asked = 0;
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.asked += 1;
    await this.#gate;

    return this.inner.build(request);
  }
}

test("admits one build per commit, so a concurrent request joins it instead of racing it", async () => {
  const host = new GatedBuildHost();
  const namespace = namespaceFor(host);
  const builder = new WorkspaceHostModuleMapBuilder(namespace, workspaceName);

  const first = Effect.runPromise(Effect.result(builder.build(commit)));
  const second = Effect.runPromise(Effect.result(builder.build(commit)));
  host.release();
  const [left, right] = await Promise.all([first, second]);

  if (Result.isFailure(left) || Result.isFailure(right)) {
    throw new Error("both callers must receive the one build's result");
  }

  expect(encodeModuleMap(left.success)).toBe(encodeModuleMap(right.success));
  expect(
    host.inner.requests.filter((request) => request.kind === "build-step"),
    "one build ran its steps once; the second caller ran none of its own",
  ).toHaveLength(HARNESS_BUILD_STEP_NAMES.length);
  expect(namespace.names.every((name) => name === workspaceName)).toBe(true);
});

test("builds again once the build in flight has settled", async () => {
  const host = new CountingBuildHost();

  const builder = new WorkspaceHostModuleMapBuilder(namespaceFor(host), workspaceName);

  await Effect.runPromise(Effect.result(builder.build(commit)));
  await Effect.runPromise(Effect.result(builder.build(commit)));

  expect(
    host.requests.filter((request) => request.kind === "build-step"),
    "the conflict rule bounds concurrent builds; it does not cache a finished one",
  ).toHaveLength(2 * HARNESS_BUILD_STEP_NAMES.length);
});

test("a caller that stops waiting neither stops the build in flight nor drops it", async () => {
  const host = new GatedBuildHost();
  const builder = new WorkspaceHostModuleMapBuilder(namespaceFor(host), workspaceName);

  const abandoned = Effect.runFork(builder.build(commit));
  await Effect.runPromise(Effect.yieldNow);
  await Effect.runPromise(Fiber.interrupt(abandoned));

  expect(host.asked, "the abandoned caller started the build").toBe(1);

  const joined = Effect.runPromise(Effect.result(builder.build(commit)));
  host.release();

  expect(Result.isSuccess(await joined)).toBe(true);
  expect(
    host.inner.requests.filter((request) => request.kind === "build-step"),
    "the later caller joined the first build instead of starting another",
  ).toHaveLength(HARNESS_BUILD_STEP_NAMES.length);
});
