import { expect, test } from "vitest";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { HARNESS_BUILD_CONFIGURATION, planHarnessBuild } from "../../src/harness-build.js";
import {
  HARNESS_DIRECTORY,
  PROJECTS_DIRECTORY,
  WORKSPACE_ROOT,
} from "../../src/workspace-layout.js";

const commit = testHarnessCommit("5000000000000000000000000000000000000002");

test("build scratch holds no repository, and every build step starts in the workspace", () => {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);

  expect(
    [HARNESS_DIRECTORY, PROJECTS_DIRECTORY].some(
      (repository) =>
        repository === HARNESS_BUILD_CONFIGURATION.buildRoot ||
        repository.startsWith(`${HARNESS_BUILD_CONFIGURATION.buildRoot}/`),
    ),
    "build scratch must contain no repository, so clearing it destroys no checkout",
  ).toBe(false);
  expect(
    plan.steps.every((step) => step.cwd === WORKSPACE_ROOT),
    "Computer refuses a working directory outside the workspace",
  ).toBe(true);
});
