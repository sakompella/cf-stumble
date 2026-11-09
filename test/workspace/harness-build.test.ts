import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { HARNESS_BUILD_CONFIGURATION, type HarnessBuildRequest } from "../../src/harness-build.js";
import { executeHarnessBuildRequest } from "../../src/workspace/commands/build-harness.js";
import { HARNESS_BUILD_OUTPUT_PATH } from "../../src/workspace-layout.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  type WorkspacePathKind,
} from "./promise-operations.js";

const commit = testHarnessCommit("5000000000000000000000000000000000000001");

const buildDirectory = `${HARNESS_BUILD_CONFIGURATION.buildRoot}/${commit}`;

const moduleMapPath = `${buildDirectory}/${HARNESS_BUILD_CONFIGURATION.moduleMapPath}`;

class FakeBuildOperations implements PromiseOperations {
  readonly calls: string[] = [];
  readonly files = new Map<string, string>([[moduleMapPath, "{}"]]);
  readonly symlinks = new Set<string>();
  exitCode = 0;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    this.calls.push(`lstat:${path}`);

    if (this.symlinks.has(path)) return Promise.resolve("symbolic-link");

    if (this.files.has(path)) return Promise.resolve("file");

    return Promise.resolve(path.startsWith("/") ? "directory" : undefined);
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    const content = this.files.get(path);

    return content === undefined
      ? Promise.reject(new Error("missing file"))
      : Promise.resolve(content);
  }

  writeFile(path: string): Promise<void> {
    this.calls.push(`write:${path}`);

    return Promise.reject(new Error("a build never writes through the workspace surface"));
  }

  stdout: string | undefined;
  commandFailure: Error | undefined;

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${source}:${cwd}`);

    if (this.commandFailure !== undefined) return Promise.reject(this.commandFailure);

    return Promise.resolve({
      stdout: this.exitCode === 0 ? (this.stdout ?? `${source} output`) : "",
      stderr: "",
      exitCode: this.exitCode,
    });
  }
}

function build(operations: FakeBuildOperations, request: HarnessBuildRequest) {
  return Effect.runPromise(
    executeHarnessBuildRequest({
      configuration: HARNESS_BUILD_CONFIGURATION,
      operations: workspaceEffects(operations),
      request,
    }),
  );
}

test("runs a planned build phase and returns its exit code", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 3;

  await expect(
    build(operations, { kind: "build-step", harnessCommit: commit, step: "install" }),
  ).resolves.toEqual({
    ok: true,
    result: {
      kind: "command",
      stdout: "",
      stderr: "",
      exitCode: 3,
    },
  });
  expect(operations.calls).toHaveLength(1);
  expect(operations.calls.at(0)).toContain(`cd '${buildDirectory}'`);
  expect(operations.calls.at(0)).toContain(HARNESS_BUILD_CONFIGURATION.buildPhases[0].command);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("a build step that cannot run is one workspace-unavailable failure", async () => {
  const operations = new FakeBuildOperations();
  operations.commandFailure = new Error("container exited before the command could run");
  vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    build(operations, { kind: "build-step", harnessCommit: commit, step: "install" }),
  ).resolves.toEqual({ ok: false, error: { code: "workspace-unavailable" } });
});

test("publishes the module map the build wrote and returns its text through the workspace filesystem", async () => {
  const operations = new FakeBuildOperations();
  operations.files.set(HARNESS_BUILD_OUTPUT_PATH, '{"entryModule":"main.js","modules":[]}');

  const result = await build(operations, { kind: "build-output", harnessCommit: commit });

  expect(result).toEqual({
    ok: true,
    result: { kind: "module-map", text: '{"entryModule":"main.js","modules":[]}' },
  });
  expect(Object.getPrototypeOf(result), "the result crosses RPC as a plain value").toBe(
    Object.prototype,
  );
  const publish = operations.calls[0] ?? "";
  expect(publish, "the publish step names the commit's own module map and no other path").toContain(
    moduleMapPath,
  );
  expect(publish, "the publish step writes no module map text to its stdout").not.toContain("cat");
  expect(operations.calls, "the text comes from the workspace filesystem, not from stdout").toEqual(
    expect.arrayContaining([`read:${HARNESS_BUILD_OUTPUT_PATH}`]),
  );
});

test("a publish step that fails answers with its exit code, not a module map", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 3;

  const result = await build(operations, { kind: "build-output", harnessCommit: commit });

  expect(result).toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 3 },
  });
});

test("rejects a commit that is not a harness commit, so no path can escape the build root", async () => {
  const operations = new FakeBuildOperations();

  for (const value of ["../../project", `${commit}/../../etc`, "not-a-commit", ""]) {
    await expect(
      build(operations, { kind: "build-output", harnessCommit: value }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  }

  expect(operations.calls).toEqual([]);
});
