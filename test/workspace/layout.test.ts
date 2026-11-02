import { expect, test } from "vitest";
import { resolveInWorkspace } from "../../src/facet/generation-1/execution-env-paths.js";
import { parseAddressedPath } from "../../src/workspace/project/resolve.js";
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

test("the facet guard and the addressed-path space share one root", () => {
  const inside = [
    WORKSPACE_ROOT,
    HARNESS_DIRECTORY,
    projectDirectory(projectTwo.id),
    MANAGED_AGENT_INSTRUCTIONS_PATH,
  ];

  for (const path of inside) {
    const resolved = resolveInWorkspace(projectDirectory(projectOne.id), path);

    if (!resolved.ok) {
      throw new Error(`${path} is inside the workspace and must resolve`);
    }

    expect(resolved.value.absolute).toBe(path);
    expect(
      parseAddressedPath(resolved.value.addressed).ok,
      "what the guard admits, the target must be able to address",
    ).toBe(true);
  }
});

test("a sibling repository is reachable and everything above the root is not", () => {
  const cwd = projectDirectory(projectOne.id);

  expect(resolveInWorkspace(cwd, `../${projectTwo.id}/README.md`)).toMatchObject({
    ok: true,
    value: { absolute: `${projectDirectory(projectTwo.id)}/README.md` },
  });
  expect(resolveInWorkspace(cwd, "../../AGENTS.md")).toMatchObject({
    ok: true,
    value: { absolute: MANAGED_AGENT_INSTRUCTIONS_PATH },
  });

  for (const escape of ["../../../etc/passwd", "/etc/passwd", `${WORKSPACE_ROOT}/../secrets`]) {
    expect(resolveInWorkspace(cwd, escape).ok, `${escape} must not resolve`).toBe(false);
  }
});
