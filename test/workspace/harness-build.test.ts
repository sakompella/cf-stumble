import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  harnessBuildStep,
  planHarnessBuild,
  type HarnessBuildRequest,
} from "../../src/harness-build.js";
import { type CommandOutput } from "../../src/workspace/index.js";
import {
  executeHarnessBuildRequest,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";
import {
  parseHarnessBuildRequest,
  planHarnessBuildRequest,
} from "../../src/workspace/harness-build.js";
import { HARNESS_DIRECTORY, WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import { shellQuote } from "../../src/shell-quote.js";

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
    source: [
      "set -eu",
      `archive=${buildDirectory}/.harness-archive.tar`,
      `git --git-dir=${HARNESS_DIRECTORY}/.git archive --format=tar -o "$archive" ${commit}`,
      `tar -x -m --no-same-owner --no-same-permissions -C ${buildDirectory} -f "$archive"`,
      'rm -f "$archive"',
    ].join("\n"),
    cwd: WORKSPACE_ROOT,
    timeoutMs: HARNESS_BUILD_CONFIGURATION.stepTimeoutMs,
  });
  const readPlan = planHarnessBuildRequest(HARNESS_BUILD_CONFIGURATION, output);
  expect(readPlan.kind).toBe("run-command");
  expect(readPlan.kind === "run-command" ? readPlan.source : "").toContain(moduleMapPath);
});

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

test("logs a redacted cause instead of discarding it when a build step cannot run", async () => {
  const operations = new FakeBuildOperations();
  operations.commandFailure = new Error("container exited before the command could run");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    build(operations, { kind: "build-step", harnessCommit: commit, step: "install" }),
  ).resolves.toEqual({ ok: false, error: { code: "workspace-unavailable" } });

  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("workspace-unavailable");
  expect(logged).toContain("container exited before the command could run");
});

test("reads the module map the build wrote, through the shell that wrote it, and refuses a symbolic link", async () => {
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
  expect(read, "and reads it rather than searching for it").toContain('cat -- "$path"');
  expect(read, "a symbolic link is refused before anything is read").toContain(
    'if [ -L "$path" ]; then',
  );
  expect(read.indexOf('if [ -L "$path" ]; then')).toBeLessThan(read.indexOf('cat -- "$path"'));
  expect(read, "and the refusal is a failing exit rather than empty output").toContain("exit 3");
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

test("the checkout step fails on its own when the archive fails", () => {
  const checkout = harnessBuildStep(
    planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit),
    "checkout",
  );

  expect(checkout.source).not.toContain("|");
  expect(checkout.source.startsWith("set -eu")).toBe(true);
});

test("the provision step obtains the requested commit before the build reads it", () => {
  const provision = harnessBuildStep(
    planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit),
    "provision",
  );

  expect(provision.source).toContain(`commit=${shellQuote(commit)}`);
  expect(provision.source, "a fresh harness checkout should not retain all history").toContain(
    'git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging"',
  );
  expect(provision.source, "a commit pushed after provisioning must be fetched").toContain(
    'git --git-dir="$git_dir" fetch --no-tags --quiet origin "$commit"',
  );
  expect(provision.source, "an absent commit must name itself and the repository").toContain(
    'printf "harness commit %s is not in %s\\n" "$commit" "$expected_remote" >&2',
  );
});
