import { expect, test } from "vitest";
import {
  MANAGED_AGENT_INSTRUCTIONS,
  PROJECT_PROVISION_STEP_NAMES,
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { parsePublicRepositoryUrl } from "../../src/project-catalog.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import type { Project } from "../../src/project-catalog.js";
import { shellQuote } from "../../src/shell-quote.js";
import {
  HARNESS_DIRECTORY,
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  projectDirectory,
} from "../../src/workspace-layout.js";

/**
 * These tests read planned text. Nothing here runs a shell: the Workers pool has no
 * `node:child_process`, and the only Node project in vitest.config.ts matches property test files
 * alone. A passing suite therefore establishes that the planner emits the reconciliation it claims
 * to and quotes what it interpolates. It does not establish that `git` accepts these commands,
 * that a clone succeeds, or that the container can reach the remote at all.
 */

const projectOne = sampleProjectOne;
const projectTwo = sampleProjectTwo;

function planFor(project: Project) {
  return planProjectProvision(projectProvisionConfiguration(project.id), project);
}

function cloneSource(project: Project): string {
  const step = projectProvisionStep(planFor(project), "clone");
  if (step.name !== "clone") {
    throw new Error("the clone step must be the command step");
  }

  return step.source;
}

test("plans the clone before the managed instructions, and nothing else", () => {
  const plan = planFor(projectOne);

  expect(plan.projectId).toBe(projectOne.id);
  expect(plan.steps.map((step) => step.name)).toEqual([...PROJECT_PROVISION_STEP_NAMES]);
});

test("clones the repository the catalog names for the project", () => {
  expect(cloneSource(projectOne)).toContain(
    `expected_remote=${shellQuote(projectOne.repositoryUrl)}`,
  );
  expect(cloneSource(projectTwo)).toContain(
    `expected_remote=${shellQuote(projectTwo.repositoryUrl)}`,
  );
  expect(cloneSource(projectOne)).not.toContain(projectTwo.repositoryUrl);
});

test("quotes an interpolated repository URL the catalog would accept", () => {
  // The catalog's URL checks accept an embedded single quote, so the planner cannot be the place
  // that assumes a URL is shell-safe. A later configuration edit is all it would take.
  const hostile = parsePublicRepositoryUrl("https://example.invalid/'; rm -rf /; '.git");
  if (hostile === undefined) {
    throw new Error("this test needs a URL the catalog accepts and the shell would misread");
  }

  const source = cloneSource({ ...projectOne, repositoryUrl: hostile });

  expect(source).toContain(`expected_remote=${shellQuote(hostile)}`);
  expect(
    source,
    "the raw URL appearing verbatim would mean its quote was never escaped",
  ).not.toContain(hostile);
  expect(source).toContain("'\\''; rm -rf /; '\\''");
});

test("reconciles an existing clone instead of replacing its working tree", () => {
  const source = cloneSource(projectOne);

  expect(source).toContain('while ! mkdir "$lock" 2>/dev/null; do');
  expect(source, "a lock whose owner is gone must not block provisioning forever").toContain(
    '  if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then',
  );
  expect(source).toContain(
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
  );
  expect(source, "a clone becomes the project root only after it succeeds").toContain(
    [
      '  git clone "$expected_remote" "$staging"',
      '  rmdir "$repository" 2>/dev/null || true',
      '  mv "$staging" "$repository"',
    ].join("\n"),
  );
  expect(
    source,
    "a populated directory that is not a repository is reported, never deleted",
  ).toContain('    printf "%s is not a git repository and is not empty\\n" "$repository" >&2');
  expect(
    source.includes('rm -rf "$repository"'),
    "nothing here may delete a directory this step did not create",
  ).toBe(false);
  expect(source, "an unexpected origin fails the step rather than being repaired").toContain(
    'test "$actual_remote" = "$expected_remote"',
  );
  expect(
    source.includes("git fetch") || source.includes("git reset") || source.includes("git checkout"),
    "reconciling must not move the working tree the user is working in",
  ).toBe(false);
});

test("writes the managed instructions above every repository in the workspace", () => {
  const step = projectProvisionStep(planFor(projectOne), "instructions");
  if (step.name !== "instructions") {
    throw new Error("the instructions step must be the file step");
  }

  expect(step.path).toBe(MANAGED_AGENT_INSTRUCTIONS_PATH);
  for (const repository of [projectDirectory(projectOne.id), HARNESS_DIRECTORY]) {
    expect(
      step.path.startsWith(`${repository}/`),
      "a managed file inside a clone would overwrite that repository's own instructions",
    ).toBe(false);
  }
  expect(step.content).toBe(MANAGED_AGENT_INSTRUCTIONS);
  expect(step.content).toContain("Never print or commit authentication tokens.");
});

test("plans the same steps for a repeated provision of one project", () => {
  expect(planFor(projectOne)).toEqual(planFor(projectOne));
});

test("gives each project its own directory inside the one workspace", () => {
  const one = projectProvisionConfiguration(projectOne.id);
  const two = projectProvisionConfiguration(projectTwo.id);

  expect(one.projectRoot).toBe(projectDirectory(projectOne.id));
  expect(one.projectGitDir).toBe(`${one.projectRoot}/.git`);
  expect(one.projectRoot).not.toBe(two.projectRoot);
  expect(
    [one.projectRoot, two.projectRoot, HARNESS_DIRECTORY].some((directory, index, all) =>
      all.some((other, otherIndex) => otherIndex !== index && other.startsWith(`${directory}/`)),
    ),
    "no repository may sit inside another",
  ).toBe(false);
  expect(cloneSource(projectOne)).not.toContain(projectDirectory(projectTwo.id));
  expect(cloneSource(projectOne)).not.toContain(HARNESS_DIRECTORY);
});
