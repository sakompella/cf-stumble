import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  CommitBuildWorkspace,
  encodeModuleMap,
  HARNESS_BUILD_CONFIGURATION,
  WorkspaceHostModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  BuildWorkspaceHost,
  BuildWorkspaceNamespace,
} from "../../../src/supervisor/artifacts/index.js";
import { planHarnessBuild, type HarnessBuildRequest } from "../../../src/harness-build.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";

const commit = harnessCommit("6000000000000000000000000000000000000001");
const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);
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

/**
 * Stands in for the Workspace Host build surface. It answers only the requests the host accepts,
 * so a request the adapter should never send fails the test rather than silently succeeding.
 */
class FakeBuildHost implements BuildWorkspaceHost {
  readonly requests: HarnessBuildRequest[] = [];
  output: string | undefined = moduleMapFile();
  failingStep: string | undefined;
  exitCode = 3;

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    if (request.kind === "build-output") {
      return Promise.resolve(
        this.output === undefined
          ? { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 1 } }
          : {
              ok: true,
              result: { kind: "command", stdout: this.output, stderr: "", exitCode: 0 },
            },
      );
    }

    const failed = request.step === this.failingStep;
    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: "",
        stderr: failed ? "build failed" : "",
        exitCode: failed ? this.exitCode : 0,
      },
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

const workspaceName = tenantWorkspaceName("supervisor-name-of-this-tenant");

function builderFor(host: FakeBuildHost) {
  const namespace = new FakeWorkspaceNamespace(host);
  return { builder: new WorkspaceHostModuleMapBuilder(namespace, workspaceName), namespace };
}

test("builds a labeled commit through the named build workspace", async () => {
  const host = new FakeBuildHost();
  const { builder, namespace } = builderFor(host);

  const built = await builder.build(commit);

  if (built.isErr()) {
    throw new Error(`a successful build must produce a module map: ${built.error.code}`);
  }
  expect(built.value.harnessCommit).toBe(commit);
  expect(encodeModuleMap(built.value)).toBe(
    encodeModuleMap({
      harnessCommit: commit,
      entryModule: "main.js",
      modules: [entryModule, helperModule].toSorted((left, right) =>
        left.name < right.name ? -1 : 1,
      ),
    }),
  );
  expect(
    namespace.names,
    "a build runs in the tenant's own workspace, not a global build container",
  ).toEqual([workspaceName]);
});

test("offline fake workspace schedules missing repository provisioning before a labeled checkout", async () => {
  const host = new FakeBuildHost();

  await builderFor(host).builder.build(commit);

  expect(plan.steps[0]?.source).toContain('while ! mkdir "$lock" 2>/dev/null; do');
  expect(plan.steps[0]?.source).toContain('git clone "$expected_remote" "$incoming"');
  expect(host.requests).toEqual([
    { kind: "build-step", harnessCommit: commit, step: "provision" },
    { kind: "build-step", harnessCommit: commit, step: "isolate" },
    { kind: "build-step", harnessCommit: commit, step: "checkout" },
    { kind: "build-step", harnessCommit: commit, step: "build" },
    { kind: "build-output", harnessCommit: commit },
  ]);
  expect(
    host.requests.every((request) => !JSON.stringify(request).includes("git ")),
    "a build request carries a commit and a step name, never a command",
  ).toBe(true);
});

test("offline fake workspace rechecks an already provisioned repository before every labeled checkout", async () => {
  const host = new FakeBuildHost();
  const { builder } = builderFor(host);

  await builder.build(commit);
  await builder.build(commit);

  expect(
    host.requests.filter(
      (request) => request.kind === "build-step" && request.step === "provision",
    ),
  ).toEqual([
    { kind: "build-step", harnessCommit: commit, step: "provision" },
    { kind: "build-step", harnessCommit: commit, step: "provision" },
  ]);
});

test("offline fake workspace retries provisioning after an interrupted labeled checkout", async () => {
  const host = new FakeBuildHost();
  const { builder } = builderFor(host);
  host.failingStep = "checkout";

  const interrupted = await builder.build(commit);
  host.failingStep = undefined;
  const resumed = await builder.build(commit);

  if (interrupted.isOk() || resumed.isErr()) {
    throw new Error("the fake checkout interruption must recover on the next build request");
  }
  expect(interrupted.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commit,
    step: "checkout",
    exitCode: 3,
  });
  expect(
    host.requests.filter(
      (request) => request.kind === "build-step" && request.step === "provision",
    ),
  ).toEqual([
    { kind: "build-step", harnessCommit: commit, step: "provision" },
    { kind: "build-step", harnessCommit: commit, step: "provision" },
  ]);
});

test("offline fake workspace refuses an unexpected origin before the labeled checkout", async () => {
  const host = new FakeBuildHost();
  host.failingStep = "provision";

  const built = await builderFor(host).builder.build(commit);

  if (built.isOk()) {
    throw new Error("a refused provision must not reach checkout");
  }
  expect(plan.steps[0]?.source).toContain(
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
  );
  expect(plan.steps[0]?.source).toContain('test "$actual_remote" = "$expected_remote"');
  expect(built.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commit,
    step: "provision",
    exitCode: 3,
  });
  expect(host.requests).toEqual([{ kind: "build-step", harnessCommit: commit, step: "provision" }]);
});

test("reports the failing build step with its exit code", async () => {
  const host = new FakeBuildHost();
  host.failingStep = "build";

  const built = await builderFor(host).builder.build(commit);

  if (built.isOk()) {
    throw new Error("a failing build step must not produce a module map");
  }
  expect(built.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commit,
    step: "build",
    exitCode: 3,
  });
  expect(host.requests.at(-1)).toEqual({
    kind: "build-step",
    harnessCommit: commit,
    step: "build",
  });
});

test("reports missing and invalid build output as plain typed failures", async () => {
  const missing = new FakeBuildHost();
  missing.output = undefined;
  const invalid = new FakeBuildHost();
  invalid.output = "{";
  const withoutEntry = new FakeBuildHost();
  withoutEntry.output = JSON.stringify({ entryModule: "main.js", modules: [helperModule] });

  const results = [
    await builderFor(missing).builder.build(commit),
    await builderFor(invalid).builder.build(commit),
    await builderFor(withoutEntry).builder.build(commit),
  ];

  expect(results.map((result) => (result.isErr() ? result.error : "ok"))).toEqual([
    { code: "build-output-missing", harnessCommit: commit },
    { code: "build-output-invalid", harnessCommit: commit, reason: "invalid-artifact" },
    { code: "build-output-invalid", harnessCommit: commit, reason: "entry-module-not-found" },
  ]);
  expect(
    results.every(
      (result) => result.isErr() && Object.getPrototypeOf(result.error) === Object.prototype,
    ),
    "a build failure stays a plain value the Supervisor can return",
  ).toBe(true);
});

test("a refused build workspace stays a typed failure", async () => {
  const host = new FakeBuildHost();
  host.build = (request: HarnessBuildRequest): Promise<WorkspaceResult> => {
    host.requests.push(request);
    return Promise.resolve({ ok: false, error: { code: "unknown-command" } });
  };

  const built = await builderFor(host).builder.build(commit);

  if (built.isOk()) {
    throw new Error("a refused build must not produce a module map");
  }
  expect(built.error).toEqual({ code: "build-workspace-unavailable", harnessCommit: commit });
});

test("refuses a command the build plan does not contain", async () => {
  const host = new FakeBuildHost();
  const workspace = new CommitBuildWorkspace(host, HARNESS_BUILD_CONFIGURATION, commit);

  await expect(workspace.runCommand("whoami", "/")).rejects.toThrow(/planned steps/u);
  await expect(workspace.runCommand(plan.steps[0].source, "/workspace")).rejects.toThrow(
    /planned steps/u,
  );
  await expect(
    workspace.runCommand("./test.sh", HARNESS_BUILD_CONFIGURATION.buildRoot),
  ).rejects.toThrow(/planned steps/u);
  expect(host.requests, "a refused command never reaches the workspace host").toEqual([]);
});

test("refuses a read that escapes the commit's build directory", async () => {
  const host = new FakeBuildHost();
  const workspace = new CommitBuildWorkspace(host, HARNESS_BUILD_CONFIGURATION, commit);

  for (const path of [
    "/workspace/readme.md",
    `${plan.directory}/../../project/readme.md`,
    `${HARNESS_BUILD_CONFIGURATION.buildRoot}/other/build/module-map.json`,
    plan.moduleMapPath.replace("module-map.json", "secret.json"),
  ]) {
    await expect(workspace.readFile(path)).rejects.toThrow(/its own module map/u);
  }
  expect(host.requests, "a refused read never reaches the workspace host").toEqual([]);
  await expect(workspace.readFile(plan.moduleMapPath)).resolves.toBe(moduleMapFile());
});
