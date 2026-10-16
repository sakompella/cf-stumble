import { expect, test } from "vitest";
import {
  holdProvisionLock,
  MANAGED_AGENT_INSTRUCTIONS,
  PROJECT_PROVISION_STEP_NAMES,
  planProjectProvision,
  projectProvisionLockPath,
  projectProvisionStep,
} from "../../src/project-provision.js";
import {
  parseProjectId,
  parsePublicRepositoryUrl,
  PROJECT_ID_LIMIT,
} from "../../src/project-catalog.js";
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
  return planProjectProvision(project);
}

function cloneSource(project: Project): string {
  return projectProvisionStep(planFor(project), "clone").source;
}

test("plans only the clone, with no dependency step", () => {
  const plan = planFor(projectOne);

  expect(plan.projectId).toBe(projectOne.id);
  expect(plan.steps.map((step) => step.name)).toEqual(["clone"]);
  expect(PROJECT_PROVISION_STEP_NAMES).toEqual(["clone"]);
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

test("uses a shallow blobless single-branch clone", () => {
  const source = cloneSource(projectOne);

  expect(source).toContain(
    'git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging"',
  );
});

test("marks a clone that runs out of disk as a repository size failure", () => {
  const source = cloneSource(projectOne);

  expect(source).toContain(
    "grep -Eiq 'no space left on device|disk quota exceeded|not enough space'",
  );
  expect(source).toContain("exit 122");
});

test("prints the resulting clone size for structured provisioning telemetry", () => {
  expect(cloneSource(projectOne)).toContain('du -sk -- "$repository"');
  expect(cloneSource(projectOne)).toContain("cf-stumble-clone-size-kb=%s");
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

  expect(source).toContain(`lock=${shellQuote(projectProvisionLockPath(projectOne.id))}\n`);
  expect(source.indexOf(holdProvisionLock().join("\n"))).toBeLessThan(
    source.indexOf("rev-parse --is-bare-repository"),
  );
  expect(
    source,
    "the lock file is never deleted, or two holders could each lock a file",
  ).not.toMatch(/rm -rf "\$lock"/u);
  expect(source).toContain(
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
  );
  expect(source, "a clone becomes the project root only after it succeeds").toContain(
    '  if clone_output="$(git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging" 2>&1)"; then',
  );
  expect(source).toContain(
    [
      '  git -C "$staging" config core.fileMode false',
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
  expect(
    source,
    "core.fileMode belongs inside the fresh-clone branch, never on an existing checkout",
  ).not.toContain('git -C "$repository" config core.fileMode false');
});

test("keeps the managed instructions above every repository in the workspace", () => {
  for (const repository of [projectDirectory(projectOne.id), HARNESS_DIRECTORY]) {
    expect(
      MANAGED_AGENT_INSTRUCTIONS_PATH.startsWith(`${repository}/`),
      "a managed file inside a clone would overwrite that repository's own instructions",
    ).toBe(false);
  }

  expect(MANAGED_AGENT_INSTRUCTIONS).toContain(
    "Never install dependencies or create large generated trees",
  );
  expect(MANAGED_AGENT_INSTRUCTIONS).toContain(
    "--exclude=node_modules -cf - . | tar -C /tmp/cf-stumble-checks/",
  );
  expect(MANAGED_AGENT_INSTRUCTIONS).toContain("durable storage");
  expect(MANAGED_AGENT_INSTRUCTIONS).toContain("Never print or commit authentication tokens.");
});

test("gives each project its own directory inside the one workspace", () => {
  const one = projectDirectory(projectOne.id);
  const two = projectDirectory(projectTwo.id);

  expect(cloneSource(projectOne)).toContain(`repository=${shellQuote(one)}\n`);
  expect(cloneSource(projectOne)).toContain(`git_dir=${shellQuote(`${one}/.git`)}\n`);
  expect(one).not.toBe(two);
  expect(
    [one, two, HARNESS_DIRECTORY].some((directory, index, all) =>
      all.some((other, otherIndex) => otherIndex !== index && other.startsWith(`${directory}/`)),
    ),
    "no repository may sit inside another",
  ).toBe(false);
  expect(cloneSource(projectOne)).not.toContain(projectDirectory(projectTwo.id));
  expect(cloneSource(projectOne)).not.toContain(HARNESS_DIRECTORY);
});

test("the longest project id still gives a lock file name the filesystem accepts", () => {
  const longest = parseProjectId("a".repeat(PROJECT_ID_LIMIT));

  if (longest === undefined) throw new Error("an id at the limit must parse");

  const name = projectProvisionLockPath(longest).split("/").at(-1) ?? "";

  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
});
