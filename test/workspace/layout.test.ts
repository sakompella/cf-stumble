import { expect, test } from "vitest";
import {
  resolveAbsolute,
  toAddressedPath,
} from "../../src/facet/generation-0/execution-env-paths.js";
import { parseAddressedPath } from "../../src/workspace/project/index.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { projectProvisionConfiguration } from "../../src/project-provision.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import {
  BUILD_SCRATCH_ROOT,
  HARNESS_DIRECTORY,
  HARNESS_GIT_DIRECTORY,
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  PROJECTS_DIRECTORY,
  projectDirectory,
  projectGitDirectory,
  WORKSPACE_ROOT,
} from "../../src/workspace-layout.js";

/**
 * The layout of the one workspace, and the property E3 says the repository lost twice already: the
 * repository-relative root has ONE owner. The facet's path-escape guard and the project RPC
 * target's addressed-path space both read `WORKSPACE_ROOT`, so a change to that constant moves both
 * or neither. Two definitions that disagree would mean the guard and the translation disagree about
 * what is inside the workspace, which is a security divergence rather than untidiness.
 */

const projectOne = sampleProjectOne;

const projectTwo = sampleProjectTwo;

test("gives the harness, each project, and build scratch separate directories", () => {
  const directories = [
    HARNESS_DIRECTORY,
    projectDirectory(projectOne.id),
    projectDirectory(projectTwo.id),
    BUILD_SCRATCH_ROOT,
  ];

  for (const directory of [HARNESS_DIRECTORY, projectDirectory(projectOne.id)]) {
    expect(directory.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
  }

  expect(
    BUILD_SCRATCH_ROOT.startsWith(`${WORKSPACE_ROOT}/`),
    "build scratch is the container's, because a build in durable storage reset the Durable Object",
  ).toBe(false);
  expect(new Set(directories).size, "every directory is distinct").toBe(directories.length);

  for (const directory of directories) {
    for (const other of directories) {
      expect(
        directory !== other && other.startsWith(`${directory}/`),
        `${other} must not sit inside ${directory}`,
      ).toBe(false);
    }
  }

  expect(projectGitDirectory(projectOne.id)).toBe(`${projectDirectory(projectOne.id)}/.git`);
  expect(HARNESS_GIT_DIRECTORY).toBe(`${HARNESS_DIRECTORY}/.git`);
  expect(projectDirectory(projectOne.id).startsWith(`${PROJECTS_DIRECTORY}/`)).toBe(true);
});

test("the build configuration and project provisioning read this layout", () => {
  expect(HARNESS_BUILD_CONFIGURATION.buildRoot).toBe(BUILD_SCRATCH_ROOT);
  expect(HARNESS_BUILD_CONFIGURATION.harnessRepositoryRoot).toBe(HARNESS_DIRECTORY);
  expect(HARNESS_BUILD_CONFIGURATION.harnessGitDir).toBe(HARNESS_GIT_DIRECTORY);
  expect(projectProvisionConfiguration(projectOne.id)).toEqual({
    projectRoot: projectDirectory(projectOne.id),
    projectGitDir: projectGitDirectory(projectOne.id),
    agentInstructionsPath: MANAGED_AGENT_INSTRUCTIONS_PATH,
  });
});

test("the facet guard and the addressed-path space share one root", () => {
  const inside = [
    WORKSPACE_ROOT,
    HARNESS_DIRECTORY,
    projectDirectory(projectTwo.id),
    MANAGED_AGENT_INSTRUCTIONS_PATH,
  ];

  for (const path of inside) {
    const resolved = resolveAbsolute(projectDirectory(projectOne.id), path);

    if (!resolved.ok) {
      throw new Error(`${path} is inside the workspace and must resolve`);
    }

    expect(resolved.value).toBe(path);
    expect(
      parseAddressedPath(toAddressedPath(resolved.value)).ok,
      "what the guard admits, the target must be able to address",
    ).toBe(true);
  }
});

test("a sibling repository is reachable and everything above the root is not", () => {
  const cwd = projectDirectory(projectOne.id);

  expect(resolveAbsolute(cwd, `../${projectTwo.id}/README.md`)).toEqual({
    ok: true,
    value: `${projectDirectory(projectTwo.id)}/README.md`,
  });
  expect(resolveAbsolute(cwd, "../../AGENTS.md")).toEqual({
    ok: true,
    value: MANAGED_AGENT_INSTRUCTIONS_PATH,
  });

  for (const escape of ["../../../etc/passwd", "/etc/passwd", `${WORKSPACE_ROOT}/../secrets`]) {
    expect(resolveAbsolute(cwd, escape).ok, `${escape} must not resolve`).toBe(false);
  }
});
