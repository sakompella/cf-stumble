/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import {
  planHarnessBuild,
  WorkspaceModuleMapBuilder,
} from "../../../src/supervisor/artifacts/index.js";
import type {
  BuildWorkspace,
  HarnessBuildConfiguration,
} from "../../../src/supervisor/artifacts/index.js";
import type { CommandOutput } from "../../../src/workspace/index.js";
import { PROJECTS_DIRECTORY, WORKSPACE_ROOT } from "../../../src/workspace-layout.js";

const configuration: HarnessBuildConfiguration = {
  buildRoot: "/harness-builds",
  harnessRepositoryRoot: "/harness",
  harnessGitDir: "/harness/.git",
  harnessGitRemote: "https://github.com/sakompella/cf-stumble.git",
  buildCommand: "pnpm run build:module-map",
  moduleMapPath: "build/module-map.json",
  stepTimeoutMs: 60_000,
};

const commit = harnessCommit("2000000000000000000000000000000000000001");

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

function succeeded(): CommandOutput {
  return { stdout: "", stderr: "", exitCode: 0 };
}

/**
 * Stands in for the Computer build workspace. It records the commands it was asked to run and
 * returns whatever the test placed at the build's output path.
 */
class FakeBuildWorkspace implements BuildWorkspace {
  readonly commands: { readonly source: string; readonly cwd: string }[] = [];
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

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.commands.push({ source, cwd });
    if (this.unavailable) {
      return Promise.reject(new Error("the build workspace is gone"));
    }

    return Promise.resolve(
      this.failing !== undefined && source.includes(this.failing)
        ? { stdout: "", stderr: "build failed", exitCode: 3 }
        : succeeded(),
    );
  }

  readFile(path: string): Promise<string> {
    const output = this.outputs[this.reads];
    this.reads += 1;
    if (output === undefined) {
      return Promise.reject(new Error(`no build output at ${path}`));
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
    "build",
  ]);
  const build = plan.steps.at(-1);
  expect(build?.name).toBe("build");
  expect(build?.cwd).toBe(WORKSPACE_ROOT);
  expect(build?.source).toContain(`cd '${plan.directory}'`);
  expect(build?.source).toContain(configuration.buildCommand);
  expect(
    build?.source,
    "the build's own output is bounded, and its exit code survives the pipe",
  ).toContain("set -o pipefail");
  expect(
    plan.steps.every((step) => !step.source.includes(PROJECTS_DIRECTORY)),
    "a harness build must not name a project directory",
  ).toBe(true);
});

test("checks out the commit before it runs the build command", async () => {
  const workspace = new FakeBuildWorkspace({ outputs: [moduleMapFile([entryModule])] });

  await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  expect(workspace.commands[2]?.source).toContain(
    `git --git-dir=/harness/.git archive --format=tar -o "$archive" ${commit}`,
  );
  expect(workspace.commands[2]?.source).toContain(
    `tar -x -m --no-same-owner --no-same-permissions -C /harness-builds/${commit}`,
  );
  expect(workspace.commands[3]?.cwd).toBe(WORKSPACE_ROOT);
  expect(workspace.commands[3]?.source).toContain(`cd '/harness-builds/${commit}'`);
  expect(workspace.commands[3]?.source).toContain(configuration.buildCommand);
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
  });
});

test("reports the failing build step and its exit code", async () => {
  const workspace = new FakeBuildWorkspace({ failing: configuration.buildCommand });

  const built = await new WorkspaceModuleMapBuilder(workspace, configuration).build(commit);

  if (built.isOk()) {
    throw new Error("a failing build command must not produce a module map");
  }
  expect(built.error).toEqual({
    code: "build-step-failed",
    harnessCommit: commit,
    step: "build",
    exitCode: 3,
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
