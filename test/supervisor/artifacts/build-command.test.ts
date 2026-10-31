import { expect, test } from "vitest";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  HARNESS_BUILD_STEP_NAMES,
  planHarnessBuild,
  type HarnessBuildConfiguration,
} from "../../../src/harness-build.js";
import { PROJECTS_DIRECTORY, WORKSPACE_ROOT } from "../../../src/workspace-layout.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const manifestFiles = import.meta.glob("../../../package.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

const manifest = Object.values(manifestFiles).at(0) ?? "";

function scriptNames(): readonly string[] {
  const start = manifest.indexOf('"scripts": {');
  const block = manifest.slice(start, manifest.indexOf("\n  },", start));

  return [...block.matchAll(/^ {4}"([^"]+)":/gmu)].map((match) => match[1] ?? "");
}

function scriptCommand(name: string): string {
  const line = new RegExp(`^ {4}"${name}": "(.*)",?$`, "mu").exec(manifest);

  if (line === null) {
    throw new Error(`package.json defines no ${name} script`);
  }

  return line[1] ?? "";
}

test("every configured build phase names a script this repository defines", () => {
  for (const phase of HARNESS_BUILD_CONFIGURATION.buildPhases) {
    if (/^pnpm install(?: --[\w-]+(?:=[\w-]+)?)+$/u.test(phase.command)) {
      continue;
    }

    const named = /^pnpm run (?<script>[\w:-]+)$/u.exec(phase.command);
    expect(
      named,
      `the ${phase.name} phase must name one script or install with flags only, not spell out a command line`,
    ).not.toBe(null);
    const script = named?.groups?.["script"] ?? "";
    expect(scriptNames(), `package.json must define ${script}`).toContain(script);
  }
});

test("the configured phases are, in order, what build:artifact runs locally", () => {
  const phases = HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.command);

  expect(
    scriptCommand("build:artifact"),
    "a developer, the clean-build probe and the deployed build must run the same work in the same order",
  ).toBe(phases.join(" && "));
  expect(phases[0], "a freshly extracted commit has no node_modules").toContain(
    "pnpm install --frozen-lockfile",
  );
  expect(phases[1], "esbuild cannot resolve Pi Durable before the install").toBe(
    "pnpm run build:module-map",
  );
});

const commit = testHarnessCommit("6000000000000000000000000000000000000003");

const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

test("plans each build phase as its own step, in the order the phases depend on", () => {
  expect(plan.steps.map((step) => step.name)).toEqual([
    "provision",
    "isolate",
    "checkout",
    ...HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name),
  ]);
  expect(plan.steps.map((step) => step.name)).toEqual(HARNESS_BUILD_STEP_NAMES);

  for (const phase of HARNESS_BUILD_CONFIGURATION.buildPhases) {
    const own = plan.steps.filter((step) => step.source.includes(phase.command));
    expect(
      own.map((step) => step.name),
      `${phase.command} belongs to the ${phase.name} step and to no other`,
    ).toEqual([phase.name]);
  }

  expect(
    plan.steps.filter((step) => step.source.includes(" archive ")).map((step) => step.name),
    "extracting the commit is the checkout step, not a build phase",
  ).toEqual(["checkout"]);
});

test("plans an isolated build directory outside the project workspace", () => {
  const configuration: HarnessBuildConfiguration = {
    ...HARNESS_BUILD_CONFIGURATION,
    buildRoot: "/harness-builds",
    harnessRepositoryRoot: "/harness",
    harnessGitDir: "/harness/.git",
  };

  const isolated = planHarnessBuild(configuration, commit);

  expect(isolated.directory).toBe(`/harness-builds/${commit}`);
  expect(isolated.moduleMapPath).toBe(`/harness-builds/${commit}/build/module-map.json`);

  for (const phase of configuration.buildPhases) {
    const step = isolated.steps.find((planned) => planned.name === phase.name);
    expect(step?.cwd).toBe(WORKSPACE_ROOT);
    expect(step?.source).toContain(`cd '${isolated.directory}'`);
    expect(step?.source).toContain(phase.command);
    expect(
      step?.source,
      "each phase's own output is bounded, and its exit code survives the pipe",
    ).toContain("set -o pipefail");
  }

  expect(
    isolated.steps.every((step) => !step.source.includes(PROJECTS_DIRECTORY)),
    "a harness build must not name a project directory",
  ).toBe(true);
});

test("provisions the harness repository under a lock and refuses an unexpected origin", () => {
  const provision = plan.steps[0]?.source;

  expect(provision).toContain('exec 9>"$lock"\nflock 9');
  expect(provision).toContain(
    'git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging"',
  );
  expect(provision).toContain(
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
  );
  expect(provision).toContain('if test "$actual_remote" != "$expected_remote"; then');
});
