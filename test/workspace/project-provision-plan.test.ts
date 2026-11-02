import { expect, test } from "vitest";
import { projectCloneSource, projectProvisionLockPath } from "../../src/project-provision.js";
import {
  parseProjectId,
  parsePublicRepositoryUrl,
  PROJECT_ID_LIMIT,
} from "../../src/project-catalog.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { shellQuote } from "../../src/shell-quote.js";
import {
  HARNESS_DIRECTORY,
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  projectDirectory,
} from "../../src/workspace-layout.js";

const projectOne = sampleProjectOne;

const projectTwo = sampleProjectTwo;

test("clones the repository the catalog names for the project", () => {
  expect(projectCloneSource(projectOne)).toContain(
    `expected_remote=${shellQuote(projectOne.repositoryUrl)}`,
  );
  expect(projectCloneSource(projectTwo)).toContain(
    `expected_remote=${shellQuote(projectTwo.repositoryUrl)}`,
  );
  expect(projectCloneSource(projectOne)).not.toContain(projectTwo.repositoryUrl);
});

test("uses a shallow blobless single-branch clone", () => {
  const source = projectCloneSource(projectOne);

  expect(source).toContain(
    'git clone --filter=blob:none --depth=50 --single-branch "$expected_remote" "$staging"',
  );
});

test("quotes an interpolated repository URL the catalog would accept", () => {
  const hostile = parsePublicRepositoryUrl("https://example.invalid/'; rm -rf /; '.git");

  if (hostile === undefined) {
    throw new Error("this test needs a URL the catalog accepts and the shell would misread");
  }

  const source = projectCloneSource({ ...projectOne, repositoryUrl: hostile });

  expect(source).toContain(`expected_remote=${shellQuote(hostile)}`);
  expect(
    source,
    "the raw URL appearing verbatim would mean its quote was never escaped",
  ).not.toContain(hostile);
  expect(source).toContain("'\\''; rm -rf /; '\\''");
});

test("keeps the managed instructions path above every repository in the workspace", () => {
  for (const repository of [projectDirectory(projectOne.id), HARNESS_DIRECTORY]) {
    expect(
      MANAGED_AGENT_INSTRUCTIONS_PATH.startsWith(`${repository}/`),
      "a managed file inside a clone would overwrite that repository's own instructions",
    ).toBe(false);
  }
});

test("clones into the project's own directory and names no other repository", () => {
  const one = projectDirectory(projectOne.id);

  expect(projectCloneSource(projectOne)).toContain(`repository=${shellQuote(one)}\n`);
  expect(projectCloneSource(projectOne)).toContain(`git_dir=${shellQuote(`${one}/.git`)}\n`);
  expect(projectCloneSource(projectOne)).not.toContain(projectDirectory(projectTwo.id));
  expect(projectCloneSource(projectOne)).not.toContain(HARNESS_DIRECTORY);
});

test("the longest project id still gives a lock file name the filesystem accepts", () => {
  const longest = parseProjectId("a".repeat(PROJECT_ID_LIMIT));

  if (longest === undefined) throw new Error("an id at the limit must parse");

  const name = projectProvisionLockPath(longest).split("/").at(-1) ?? "";

  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
});
