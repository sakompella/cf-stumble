import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../src/harness-commit.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  harnessBuildStep,
  planHarnessBuild,
} from "../../src/harness-build.js";
import {
  HARNESS_DIRECTORY,
  PROJECTS_DIRECTORY,
  WORKSPACE_ROOT,
} from "../../src/workspace-layout.js";

/**
 * What a build is allowed to write in the one shared workspace (ADR-0038). It extracts into scratch
 * that holds no repository, and it never replaces the checkout the owner edits. These are read as
 * planned text: no test in this repository runs a shell, so a green run shows what the plan asks
 * for, not what `git` and `rm` then do with it.
 */

const commit = harnessCommit("5000000000000000000000000000000000000002");
const buildDirectory = `${HARNESS_BUILD_CONFIGURATION.buildRoot}/${commit}`;
const moduleMapPath = `${buildDirectory}/${HARNESS_BUILD_CONFIGURATION.moduleMapPath}`;

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commits must be valid harness commits");
  }

  return parsed;
}

test("keeps build scratch apart from every repository in the workspace", () => {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

  expect(plan.directory).toBe(buildDirectory);
  expect(plan.moduleMapPath).toBe(moduleMapPath);
  expect(
    [HARNESS_DIRECTORY, PROJECTS_DIRECTORY].some(
      (repository) =>
        repository === HARNESS_BUILD_CONFIGURATION.buildRoot ||
        repository.startsWith(`${HARNESS_BUILD_CONFIGURATION.buildRoot}/`),
    ),
    "build scratch must contain no repository, so clearing it destroys no checkout",
  ).toBe(false);
  expect(
    plan.steps.every((step) => !step.source.includes(PROJECTS_DIRECTORY)),
    "a harness build must not name a project directory",
  ).toBe(true);
  expect(
    plan.steps.every((step) => step.cwd === WORKSPACE_ROOT),
    "every build step runs in the workspace, because Computer refuses a working directory outside it",
  ).toBe(true);
  expect(
    harnessBuildStep(plan, "build").source.includes(`cd '${buildDirectory}'`),
    "and the build command changes into its own scratch directory itself",
  ).toBe(true);
  expect(
    harnessBuildStep(plan, "isolate").source,
    "the only thing a build deletes is its own scratch directory",
  ).toBe(
    `mkdir -p ${HARNESS_BUILD_CONFIGURATION.buildRoot} && rm -rf ${buildDirectory} && mkdir -p ${buildDirectory}`,
  );
});

test("a build never replaces the editable harness checkout", () => {
  const provision = harnessBuildStep(
    planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit),
    "provision",
  );

  expect(
    provision.source.indexOf('git clone "$expected_remote" "$incoming"'),
    "a replacement clone must land beside the repository, not on top of it",
  ).toBeGreaterThan(0);
  expect(
    provision.source.includes('rm -rf "$repository"'),
    "the checkout the owner edits must survive a clone that never finishes",
  ).toBe(false);
  expect(
    provision.source,
    "a populated directory that is not a repository is reported, never deleted",
  ).toContain('    printf "%s is not a git repository and is not empty\\n" "$repository" >&2');
  expect(provision.source, "only an empty directory is removed").toContain(
    '  rmdir "$repository" 2>/dev/null || true',
  );
});
