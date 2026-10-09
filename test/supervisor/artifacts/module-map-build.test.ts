/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, expect, test, vi } from "vitest";
import { everythingLogged, textLines } from "../../log-capture.js";
import { syntheticJwt } from "../../synthetic-jwt.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  planHarnessBuild,
  WorkspaceModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  BuildWorkspace,
  HarnessBuildConfiguration,
} from "../../../src/supervisor/artifacts/index.js";
import type { HarnessBuildStep } from "../../../src/harness-build.js";
import type { CommandOutput } from "../../../src/workspace/index.js";
import { PROJECTS_DIRECTORY, WORKSPACE_ROOT } from "../../../src/workspace-layout.js";

const configuration: HarnessBuildConfiguration = {
  buildRoot: "/harness-builds",
  harnessRepositoryRoot: "/harness",
  harnessGitDir: "/harness/.git",
  harnessGitRemote: "https://github.com/sakompella/cf-stumble.git",
  buildPhases: [
    {
      name: "install",
      command: "pnpm install --frozen-lockfile --reporter=silent --ignore-scripts",
    },
    { name: "build-pi", command: "pnpm run build:pi" },
    { name: "build-module-map", command: "pnpm run build:module-map" },
  ],
  moduleMapPath: "build/module-map.json",
  stepTimeoutMs: 60_000,
};

const commit = testHarnessCommit("2000000000000000000000000000000000000001");

afterEach(() => {
  vi.restoreAllMocks();
});

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

function succeeded(): CommandOutput {
  return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Stands in for the Computer build workspace. It records the steps it was asked to run and
 * returns whatever the test placed as the build's module map.
 */
class FakeBuildWorkspace implements BuildWorkspace {
  readonly steps: HarnessBuildStep[] = [];
  private readonly outputs: readonly (string | undefined)[];
  private readonly failing: string | undefined;
  private readonly unavailable: boolean;
  private reads = 0;

  constructor(
    options: Readonly<{
      outputs?: readonly (string | undefined)[];
      failing?: string;
      unavailable?: boolean;
    }> = {},
  ) {
    this.outputs = options.outputs ?? [];
    this.failing = options.failing;
    this.unavailable = options.unavailable ?? false;
  }

  runStep(step: HarnessBuildStep): Promise<CommandOutput> {
    this.steps.push(step);

    if (this.unavailable) {
      return Promise.reject(new Error("the build workspace is gone"));
    }

    return Promise.resolve(
      this.failing !== undefined && step.source.includes(this.failing)
        ? { stdout: "", stderr: "build failed", exitCode: 3 }
        : succeeded(),
    );
  }

  readModuleMap(): Promise<string> {
    const output = this.outputs[this.reads];
    this.reads += 1;

    if (output === undefined) {
      return Promise.reject(new Error("no build output"));
    }

    return Promise.resolve(output);
  }
}

function moduleMapFile(modules: readonly Readonly<{ name: string; source: string }>[]): string {
  return JSON.stringify({ entryModule: "main.js", modules });
}

const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

test("plans an isolated build directory outside the project workspace", () => {
  const plan = planHarnessBuild(configuration, commit);

  expect(plan.directory).toBe(`/harness-builds/${commit}`);
  expect(plan.moduleMapPath).toBe(`/harness-builds/${commit}/build/module-map.json`);
  expect(plan.steps.map((step) => step.name)).toEqual([
    "provision",
    "isolate",
    "checkout",
    "install",
    "build-pi",
    "build-module-map",
  ]);

  for (const phase of configuration.buildPhases) {
    const step = plan.steps.find((planned) => planned.name === phase.name);
    expect(step?.cwd).toBe(WORKSPACE_ROOT);
    expect(step?.source).toContain(`cd '${plan.directory}'`);
    expect(step?.source).toContain(phase.command);
    expect(
      step?.source,
      "each phase's own output is bounded, and its exit code survives the pipe",
    ).toContain("set -o pipefail");
  }

  expect(
    plan.steps.every((step) => !step.source.includes(PROJECTS_DIRECTORY)),
    "a harness build must not name a project directory",
  ).toBe(true);
});

test("reports a failed archive extraction as the checkout step, not as a build failure", async () => {
  const workspace = new FakeBuildWorkspace({ failing: "git-dir=/harness/.git archive" });

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  if (built.isOk()) {
    throw new Error("a failed archive must not produce a module map");
  }

  expect(built.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commit,
    step: "checkout",
    exitCode: 3,
    diagnostics: { stdoutTail: "", stderrTail: "build failed", truncated: false },
  });
});

test("reports an unavailable build workspace", async () => {
  const workspace = new FakeBuildWorkspace({ unavailable: true });

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  if (built.isOk()) {
    throw new Error("an unavailable workspace must not produce a module map");
  }

  expect(built.error).toEqual({ code: "build-workspace-unavailable", harnessCommit: commit });
});

test("an unavailable build workspace logs its cause with every credential redacted", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const jwt = syntheticJwt();

  const workspace: BuildWorkspace = {
    runStep: () =>
      Promise.reject(new Error(`container refused ${jwt.token} for x:${FAKE_TOKEN}@github.com`)),
    readModuleMap: () => Promise.reject(new Error("a failed step reads no output")),
  };

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  expect(built.isErr() ? built.error.code : "ok").toBe("build-workspace-unavailable");
  expect(textLines(errors).join("\n"), "the cause still explains the failure").toMatch(
    /harness-build\.provision: build-workspace-unavailable: container refused \[redacted\]/u,
  );

  const logged = everythingLogged();

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
  expect(logged).not.toContain(FAKE_TOKEN);
});

test("missing build output logs its cause with every credential redacted", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const jwt = syntheticJwt();

  const workspace: BuildWorkspace = {
    runStep: () => Promise.resolve(succeeded()),
    readModuleMap: () =>
      Promise.reject(new Error(`no file; request carried ${jwt.token} ${FAKE_TOKEN}`)),
  };

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  expect(built.isErr() ? built.error.code : "ok").toBe("build-output-missing");
  expect(textLines(errors).join("\n"), "the log still names the path the build reads").toContain(
    `harness-build.output /harness-builds/${commit}/build/module-map.json: build-output-missing: no file`,
  );

  const logged = everythingLogged();

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
  expect(logged).not.toContain(FAKE_TOKEN);
});

test("reports missing and invalid build output", async () => {
  const missing = new WorkspaceModuleMapBuilder(new FakeBuildWorkspace(), configuration);

  const unparsable = new WorkspaceModuleMapBuilder(
    new FakeBuildWorkspace({ outputs: ["{"] }),
    configuration,
  );

  const withoutEntry = new WorkspaceModuleMapBuilder(
    new FakeBuildWorkspace({ outputs: [moduleMapFile([helperModule])] }),
    configuration,
  );

  const results = [
    await missing.build(commit),
    await unparsable.build(commit),
    await withoutEntry.build(commit),
  ];

  expect(results.map((result) => (result.isErr() ? result.error : "ok"))).toEqual([
    { code: "build-output-missing", harnessCommit: commit },
    { code: "build-output-invalid", harnessCommit: commit, reason: "invalid-artifact" },
    { code: "build-output-invalid", harnessCommit: commit, reason: "entry-module-not-found" },
  ]);
});

test("gives the built module map the commit the Supervisor asked to build", async () => {
  const foreign = "3000000000000000000000000000000000000009";

  const workspace = new FakeBuildWorkspace({
    outputs: [
      JSON.stringify({ harnessCommit: foreign, entryModule: "main.js", modules: [entryModule] }),
    ],
  });

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  if (built.isErr()) {
    throw new Error("a valid build output must produce a module map");
  }

  expect(built.value.harnessCommit).toBe(commit);
});
