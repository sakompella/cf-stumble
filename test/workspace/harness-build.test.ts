import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import {
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
} from "../../src/workspace/commands/build-harness.js";
import { BUILD_SCRATCH_ROOT, harnessBuildOutputPath } from "../../src/workspace-layout.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  type WorkspacePathKind,
} from "./promise-operations.js";

const commit = testHarnessCommit("5000000000000000000000000000000000000001");

const buildDirectory = `${BUILD_SCRATCH_ROOT}/${commit}`;

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

    this.#applyFileChanges(source);

    return Promise.resolve({
      stdout: this.exitCode === 0 ? (this.stdout ?? `${source} output`) : "",
      stderr: "",
      exitCode: this.exitCode,
    });
  }

  #applyFileChanges(source: string): void {
    const assigned = (name: string) => new RegExp(`^${name}='([^']*)'$`, "mu").exec(source)?.[1];
    const from = assigned("path");
    const to = assigned("output");

    if (source.includes('cp -- "$path" "$output"') && from !== undefined && to !== undefined) {
      this.files.set(to, this.files.get(from) ?? "");
    }

    const removed = /^rm -rf -- (.*)$/mu.exec(source)?.[1] ?? "";

    for (const [, path = ""] of removed.matchAll(/'([^']*)'/gu)) {
      for (const file of this.files.keys()) {
        if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
      }
    }
  }
}

function request(operations: FakeBuildOperations) {
  return {
    configuration: HARNESS_BUILD_CONFIGURATION,
    operations: workspaceEffects(operations),
  };
}

function buildStep(operations: FakeBuildOperations, step: string, harnessCommit: string = commit) {
  return Effect.runPromise(
    executeHarnessBuildStep({ ...request(operations), request: { harnessCommit, step } }),
  );
}

function buildOutput(operations: FakeBuildOperations, harnessCommit: string = commit) {
  return Effect.runPromise(
    executeHarnessBuildOutput({ ...request(operations), request: harnessCommit }),
  );
}

function discard(operations: FakeBuildOperations, harnessCommit: string = commit) {
  return Effect.runPromise(
    executeHarnessBuildDiscard({ ...request(operations), request: harnessCommit }),
  );
}

test("a build phase answers with its exit code", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 3;

  await expect(buildStep(operations, "install")).resolves.toEqual({
    ok: true,
    output: { stdout: "", stderr: "", exitCode: 3 },
  });
});

test("a build step that cannot run is one workspace-unavailable failure", async () => {
  const operations = new FakeBuildOperations();
  operations.commandFailure = new Error("container exited before the command could run");

  await expect(buildStep(operations, "install")).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable" },
  });
});

test("a build step this Host does not know is refused and runs nothing, so it can never reach the scratch cleanup", async () => {
  const operations = new FakeBuildOperations();

  for (const step of ["clean", "discard", "build-discard", "rm", "", "constructor"]) {
    await expect(buildStep(operations, step), step).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  }

  expect(operations.calls).toEqual([]);
});

test("publishes the module map the build wrote and returns its text through the workspace filesystem", async () => {
  const operations = new FakeBuildOperations();
  operations.files.set(moduleMapPath, '{"entryModule":"main.js","modules":[]}');

  const result = await buildOutput(operations);

  expect(result).toEqual({ ok: true, moduleMap: '{"entryModule":"main.js","modules":[]}' });
  expect(Object.getPrototypeOf(result), "the result crosses RPC as a plain value").toBe(
    Object.prototype,
  );
});

test("a publish step that fails answers publish-failed with its output, not a module map", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 3;

  await expect(buildOutput(operations)).resolves.toEqual({
    ok: false,
    error: { code: "publish-failed", output: { stdout: "", stderr: "", exitCode: 3 } },
  });
});

test("rejects a commit that is not a harness commit, so no path can escape the build root", async () => {
  const operations = new FakeBuildOperations();

  for (const value of ["../../project", `${commit}/../../etc`, "not-a-commit", ""]) {
    const refused = { ok: false, error: { code: "invalid-request" } };

    await expect(buildOutput(operations, value)).resolves.toEqual(refused);
    await expect(discard(operations, value)).resolves.toEqual(refused);
    await expect(buildStep(operations, "install", value)).resolves.toEqual(refused);
  }

  expect(operations.calls).toEqual([]);
});

test("two commits published at once each read their own module map", async () => {
  const other = testHarnessCommit("5000000000000000000000000000000000000002");
  const otherMap = `${BUILD_SCRATCH_ROOT}/${other}/${HARNESS_BUILD_CONFIGURATION.moduleMapPath}`;
  const operations = new FakeBuildOperations();
  operations.files.set(moduleMapPath, '{"entryModule":"a.js","modules":[]}');
  operations.files.set(otherMap, '{"entryModule":"b.js","modules":[]}');
  const read = operations.readFile.bind(operations);
  let interleaved = false;
  operations.readFile = async (path) => {
    if (!interleaved) {
      interleaved = true;
      await buildOutput(operations, other);
    }

    return read(path);
  };

  const published = await buildOutput(operations);
  await discard(operations, other);

  expect(published).toEqual({ ok: true, moduleMap: '{"entryModule":"a.js","modules":[]}' });
  expect(operations.files.get(harnessBuildOutputPath(commit))).toBe(
    '{"entryModule":"a.js","modules":[]}',
  );
});
