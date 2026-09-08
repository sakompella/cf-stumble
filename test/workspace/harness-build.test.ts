import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../src/harness-commit.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  harnessBuildStep,
  planHarnessBuild,
  readModuleMapSource,
  shellQuote,
} from "../../src/harness-build.js";
import {
  executeHarnessBuildRequest,
  parseHarnessBuildRequest,
  planHarnessBuildRequest,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";
import { HARNESS_DIRECTORY } from "../../src/workspace-layout.js";

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

  stdout: string | undefined;

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${source}:${cwd}`);
    return Promise.resolve({
      stdout: this.exitCode === 0 ? (this.stdout ?? `${source} output`) : "",
      stderr: "",
      exitCode: this.exitCode,
    });
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
    cwd: "/",
    timeoutMs: HARNESS_BUILD_CONFIGURATION.stepTimeoutMs,
  });
  expect(planHarnessBuildRequest(HARNESS_BUILD_CONFIGURATION, output)).toEqual({
    kind: "run-command",
    source: readModuleMapSource(planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit)),
    cwd: "/",
    timeoutMs: HARNESS_BUILD_CONFIGURATION.stepTimeoutMs,
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
      stdout: "",
      stderr: "",
      exitCode: 3,
    },
  });
  expect(operations.calls).toEqual([
    `command:${HARNESS_BUILD_CONFIGURATION.buildCommand}:${buildDirectory}`,
  ]);
});

test("reads the module map the build wrote, through the shell that wrote it", async () => {
  const operations = new FakeBuildOperations();
  operations.stdout = '{"entryModule":"main.js","modules":[]}';

  await expect(build(operations, { kind: "build-output", harnessCommit: commit })).resolves.toEqual(
    {
      ok: true,
      result: {
        kind: "command",
        stdout: '{"entryModule":"main.js","modules":[]}',
        stderr: "",
        exitCode: 0,
      },
    },
  );
  const read = operations.calls.at(0) ?? "";
  expect(read, "the read names the commit's own module map and no other path").toContain(
    moduleMapPath,
  );
  expect(read, "and reads it rather than searching for it").toContain('cat -- "$path"');
});

test("reports a build that wrote no module map as a non-zero read", async () => {
  const operations = new FakeBuildOperations();
  operations.exitCode = 1;

  await expect(build(operations, { kind: "build-output", harnessCommit: commit })).resolves.toEqual(
    {
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 1 },
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

test("refuses a module map reached through a symbolic link", () => {
  const source = readModuleMapSource(planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit));

  expect(source, "a symbolic link is refused before anything is read").toContain(
    'if [ -L "$path" ]; then',
  );
  expect(source.indexOf('if [ -L "$path" ]; then')).toBeLessThan(source.indexOf('cat -- "$path"'));
  expect(source, "and the refusal is a failing exit rather than empty output").toContain("exit 3");
});

test("the checkout step fails on its own when the archive fails", () => {
  const checkout = harnessBuildStep(
    planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit),
    "checkout",
  );

  // `git archive | tar -x` reports tar's exit code, so a failed archive used to reach the build
  // step as an empty directory and a compilation error that named the wrong fault.
  expect(checkout.source).not.toContain("|");
  expect(checkout.source.startsWith("set -eu")).toBe(true);
});

test("the provision step obtains the requested commit before the build reads it", () => {
  const provision = harnessBuildStep(
    planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit),
    "provision",
  );

  expect(provision.source).toContain(`commit=${shellQuote(commit)}`);
  expect(provision.source, "a commit pushed after provisioning must be fetched").toContain(
    'git --git-dir="$git_dir" fetch --no-tags --quiet origin "$commit"',
  );
  expect(provision.source, "an absent commit must name itself and the repository").toContain(
    'printf "harness commit %s is not in %s\\n" "$commit" "$expected_remote" >&2',
  );
});

test("shellQuote emits POSIX single-quote escaping the shell can parse", () => {
  expect(shellQuote("plain")).toBe("'plain'");
  expect(shellQuote("/workspace/harness/.git")).toBe("'/workspace/harness/.git'");
  expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");

  // A single quote closes the literal, emits an escaped quote, then reopens it. An extra backslash
  // here yields a string no shell can parse, which is how a quoting helper turns into an injection
  // the first time a caller passes something other than a constant.
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
  expect(shellQuote("'")).toBe("''\\'''");
});
