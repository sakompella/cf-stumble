import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  encodeModuleMap,
  WorkspaceHostModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  BuildWorkspaceHost,
  BuildWorkspaceNamespace,
} from "../../../src/supervisor/artifacts/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { HarnessBuildRequest } from "../../../src/harness-build.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";

/**
 * Two builds of one commit share a scratch directory named after that commit, and the isolate step
 * clears it, so the second build would delete the files the first is compiling. T1a handed that
 * race over in writing. These tests hold the rule that answers it: one build per commit at a time,
 * within the tenant whose workspace the build runs in.
 */

const commit = harnessCommit("6000000000000000000000000000000000000002");
const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");
const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };
const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

function moduleMapFile(): string {
  return JSON.stringify({ entryModule: "main.js", modules: [helperModule, entryModule] });
}

/** Answers only the requests the real build surface accepts, and counts what it was asked for. */
class CountingBuildHost implements BuildWorkspaceHost {
  readonly requests: HarnessBuildRequest[] = [];

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    if (request.kind === "build-output") {
      return Promise.resolve({ ok: true, result: { kind: "file", content: moduleMapFile() } });
    }

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }
}

class FakeWorkspaceNamespace implements BuildWorkspaceNamespace {
  readonly names: string[] = [];
  readonly host: BuildWorkspaceHost;

  constructor(host: BuildWorkspaceHost) {
    this.host = host;
  }

  getByName(name: string): BuildWorkspaceHost {
    this.names.push(name);
    return this.host;
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
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    await this.#gate;
    return this.inner.build(request);
  }
}

test("admits one build per commit, so a concurrent request joins it instead of racing it", async () => {
  const host = new GatedBuildHost();
  const namespace = new FakeWorkspaceNamespace(host);
  const builder = new WorkspaceHostModuleMapBuilder(namespace, workspaceName);

  const first = builder.build(commit);
  const second = builder.build(commit);
  host.release();
  const [left, right] = await Promise.all([first, second]);

  if (left.isErr() || right.isErr()) {
    throw new Error("both callers must receive the one build's result");
  }
  expect(encodeModuleMap(left.value)).toBe(encodeModuleMap(right.value));
  expect(
    host.inner.requests.filter((request) => request.kind === "build-step"),
    "one build ran its four steps once; the second caller ran none of its own",
  ).toHaveLength(4);
  expect(namespace.names).toEqual([workspaceName]);
});

test("builds again once the build in flight has settled", async () => {
  const host = new CountingBuildHost();
  const builder = new WorkspaceHostModuleMapBuilder(
    new FakeWorkspaceNamespace(host),
    workspaceName,
  );

  await builder.build(commit);
  await builder.build(commit);

  expect(
    host.requests.filter((request) => request.kind === "build-step"),
    "the conflict rule bounds concurrent builds; it does not cache a finished one",
  ).toHaveLength(8);
});
