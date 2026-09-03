import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../src/harness-commit.js";
import { HARNESS_BUILD_CONFIGURATION, planHarnessBuild } from "../../src/harness-build.js";
import { HARNESS_BUILD_WORKSPACE_NAME, PROJECT_WORKSPACE_NAME } from "../../src/workspace-names.js";
import {
  executeHarnessBuildRequest,
  executeWorkspaceRequest,
  parseHarnessBuildRequest,
  planHarnessBuildRequest,
  type CommandOutput,
  type WorkspaceConfiguration,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";

const PROJECT_ROOT = "/project";

const projectConfiguration = {
  root: PROJECT_ROOT,
  commands: { check: "./test.sh" },
} as const satisfies WorkspaceConfiguration;

const commit = harnessCommit("5000000000000000000000000000000000000001");
const buildDirectory = `${HARNESS_BUILD_CONFIGURATION.buildRoot}/${commit}`;
const moduleMapPath = `${buildDirectory}/${HARNESS_BUILD_CONFIGURATION.moduleMapPath}`;

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

/** A build workspace with no project files in it: the build root is all it contains. */
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

  listFiles(path: string): Promise<readonly string[]> {
    this.calls.push(`list:${path}`);
    return Promise.reject(new Error("a build never lists through the workspace surface"));
  }

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${source}:${cwd}`);
    return Promise.resolve({ stdout: `${source} output`, stderr: "", exitCode: this.exitCode });
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function build(operations: FakeBuildOperations, request: unknown) {
  return executeHarnessBuildRequest({
    configuration: HARNESS_BUILD_CONFIGURATION,
    operations,
    request,
  });
}

test("keeps the build root, and its workspace name, apart from the project", () => {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

  expect(HARNESS_BUILD_CONFIGURATION.buildRoot).not.toBe(PROJECT_ROOT);
  expect(HARNESS_BUILD_WORKSPACE_NAME).not.toBe(PROJECT_WORKSPACE_NAME);
  expect(plan.directory).toBe(buildDirectory);
  expect(plan.moduleMapPath).toBe(moduleMapPath);
  expect(
    plan.steps.every(
      (step) => !step.source.includes(PROJECT_ROOT) && !step.cwd.startsWith(PROJECT_ROOT),
    ),
    "a harness build must not touch the project workspace",
  ).toBe(true);
});

test("plans one planned step, or the build output, from a validated commit", () => {
  const step = parseHarnessBuildRequest({
    kind: "build-step",
    harnessCommit: commit,
    step: "checkout",
  });
  const output = parseHarnessBuildRequest({ kind: "build-output", harnessCommit: commit });
  if ("ok" in step || "ok" in output) {
    throw new Error("valid build requests must parse");
  }

  expect(planHarnessBuildRequest(HARNESS_BUILD_CONFIGURATION, step)).toEqual({
    kind: "run-command",
    source: `git --git-dir=/harness/.git archive ${commit} | tar -x -C ${buildDirectory}`,
    cwd: "/",
  });
  expect(planHarnessBuildRequest(HARNESS_BUILD_CONFIGURATION, output)).toEqual({
    kind: "read-file",
    path: moduleMapPath,
  });
});

test("runs a planned build step and returns its exit code", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 3;

  await expect(
    build(operations, { kind: "build-step", harnessCommit: commit, step: "build" }),
  ).resolves.toEqual({
    ok: true,
    result: {
      kind: "command",
      stdout: `${HARNESS_BUILD_CONFIGURATION.buildCommand} output`,
      stderr: "",
      exitCode: 3,
    },
  });
  expect(operations.calls).toEqual([
    `command:${HARNESS_BUILD_CONFIGURATION.buildCommand}:${buildDirectory}`,
  ]);
});

test("reads the module map the build wrote and nothing else", async () => {
  const operations = new FakeBuildOperations();
  operations.files.set(moduleMapPath, '{"entryModule":"main.js","modules":[]}');

  await expect(build(operations, { kind: "build-output", harnessCommit: commit })).resolves.toEqual(
    {
      ok: true,
      result: { kind: "file", content: '{"entryModule":"main.js","modules":[]}' },
    },
  );
  expect(operations.calls).toContain(`read:${moduleMapPath}`);
});

test("reports a missing build output as an unavailable workspace", async () => {
  const operations = new FakeBuildOperations();
  operations.files.delete(moduleMapPath);

  await expect(build(operations, { kind: "build-output", harnessCommit: commit })).resolves.toEqual(
    {
      ok: false,
      error: { code: "workspace-unavailable" },
    },
  );
});

test("rejects caller supplied command text and every project request", async () => {
  const operations = new FakeBuildOperations();

  for (const [request, code] of [
    [null, "invalid-request"],
    [{ kind: "build-step", harnessCommit: commit }, "invalid-request"],
    [
      { kind: "build-step", harnessCommit: commit, step: "build", source: "whoami" },
      "invalid-request",
    ],
    [{ kind: "build-step", harnessCommit: commit, step: "whoami" }, "unknown-command"],
    [{ kind: "run-command", command: "check" }, "invalid-request"],
    [{ kind: "read-file", path: "readme.md" }, "invalid-request"],
    [{ kind: "git-diff" }, "invalid-request"],
    [{ kind: "build-output", harnessCommit: commit, path: "readme.md" }, "invalid-request"],
  ] as const) {
    await expect(build(operations, request)).resolves.toEqual({ ok: false, error: { code } });
  }

  expect(operations.calls, "a rejected build request runs nothing").toEqual([]);
});

test("rejects a commit that is not a harness commit, so no path can escape the build root", async () => {
  const operations = new FakeBuildOperations();

  for (const value of ["../../project", `${commit}/../../etc`, "not-a-commit", "", 7, null]) {
    await expect(
      build(operations, { kind: "build-output", harnessCommit: value }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  }

  expect(operations.calls).toEqual([]);
});

test("rejects a build output reached through a symbolic link", async () => {
  const operations = new FakeBuildOperations();
  operations.symlinks.add(buildDirectory);

  await expect(build(operations, { kind: "build-output", harnessCommit: commit })).resolves.toEqual(
    {
      ok: false,
      error: { code: "path-outside-root" },
    },
  );
  expect(operations.calls.every((call) => call.startsWith("lstat:"))).toBe(true);
});

test("keeps the project surface free of build requests", async () => {
  const operations = new FakeBuildOperations();

  await expect(
    executeWorkspaceRequest({
      configuration: projectConfiguration,
      operations,
      request: { kind: "build-step", harnessCommit: commit, step: "build" },
    }),
  ).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  expect(operations.calls).toEqual([]);
});
