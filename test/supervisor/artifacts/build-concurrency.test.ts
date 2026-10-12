import { expect, test } from "vitest";
import * as Effect from "effect/Effect";
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

/**
 * Two builds of one commit share a scratch directory named after that commit, and the isolate step
 * clears it, so the second build would delete the files the first is compiling. T1a handed that
 * race over in writing. These tests hold the rule that answers it: one build per commit at a time,
 * within the tenant whose workspace the build runs in.
 */

const commit = testHarnessCommit("6000000000000000000000000000000000000002");

const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");

const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

function moduleMapFile(): string {
  return JSON.stringify({ entryModule: "main.js", modules: [helperModule, entryModule] });
}

/** Answers only the requests the real build surface accepts, and counts what it was asked for. */
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

/**
 * A build host that answers nothing until it is released, so two builds of one commit can be in
 * flight at the same moment. Concurrency is the whole point of the test below: the build plan
 * clears a scratch directory named after the commit, so a second build of the same commit running
 * beside the first would delete the files the first is compiling.
 */
class GatedBuildHost implements BuildWorkspaceHost {
  readonly inner = new CountingBuildHost();
  /** Requests received, including those still waiting at the gate. */
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
    "one build ran its six steps once; the second caller ran none of its own",
  ).toHaveLength(6);
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
  ).toHaveLength(12);
});

/**
 * The build in flight is a native Promise that every joined caller shares. A caller that stops
 * waiting, such as an interrupted fiber, must not stop that build or drop it from the map while
 * its first step is still running, or the next request would start a second build of the same
 * commit beside it.
 */
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
  ).toHaveLength(6);
});
