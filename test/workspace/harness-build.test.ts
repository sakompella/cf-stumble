import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { HARNESS_BUILD_CONFIGURATION, type HarnessBuildRequest } from "../../src/harness-build.js";
import { type CommandOutput } from "../../src/workspace/index.js";
import {
  executeHarnessBuildRequest,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";

const commit = testHarnessCommit("5000000000000000000000000000000000000001");

const buildDirectory = `${HARNESS_BUILD_CONFIGURATION.buildRoot}/${commit}`;

const moduleMapPath = `${buildDirectory}/${HARNESS_BUILD_CONFIGURATION.moduleMapPath}`;

class FakeBuildOperations implements WorkspaceOperations {
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
      operations,
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

test("reads the module map the build wrote, through the shell that wrote it", async () => {
  const operations = new FakeBuildOperations();
  operations.stdout = '{"entryModule":"main.js","modules":[]}';

  const result = await build(operations, { kind: "build-output", harnessCommit: commit });

  expect(result).toEqual({
    ok: true,
    result: {
      kind: "command",
      stdout: '{"entryModule":"main.js","modules":[]}',
      stderr: "",
      exitCode: 0,
    },
  });
  expect(Object.getPrototypeOf(result), "the result crosses RPC as a plain value").toBe(
    Object.prototype,
  );
  const read = operations.calls.at(0) ?? "";
  expect(read, "the read names the commit's own module map and no other path").toContain(
    moduleMapPath,
  );
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
