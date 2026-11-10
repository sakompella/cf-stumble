import { expect, test } from "vitest";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  PROJECT_ID_LIMIT,
  projectIdForRepository,
  resolveProject,
} from "../src/project-catalog.js";
import { projectOf } from "./project-fixtures.js";

test("resolves every project of a non-empty catalog", () => {
  const count = 3;

  const urls = Array.from(
    { length: count },
    (_, index) => `https://github.com/sample/repo-${index}`,
  );

  const catalog = urls.map((url) => projectOf(url));

  for (const project of catalog) {
    expect(resolveProject(project.id, catalog)).toEqual({ ok: true, project });
  }

  expect(resolveProject("not-connected", catalog)).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
});

test("refuses a repository URL that no clone could use", () => {
  expect(canonicalRepositoryUrl("http://github.com/sample/repo")).toBeUndefined();
  expect(canonicalRepositoryUrl("https://token@github.com/sample/repo")).toBeUndefined();
  expect(canonicalRepositoryUrl("https://github.com/sample")).toBeUndefined();
  expect(projectIdForRepository("not a url")).toBeUndefined();
  expect(projectIdForRepository("https://github.com/--/--")).toBeUndefined();
});

test.each([
  ["owner/a-b", "owner-a-b"],
  ["sakompella/emaily-demo", "sakompella-emaily-demo"],
  ["owner/a.b", "owner-a-b--2d"],
  ["owner/a_b", "owner-a-b--2u"],
  ["owner/a--b", "owner-a-b--2hh"],
  ["owner/a._b", "owner-a-b--2du"],
  ["owner-a/b", "owner-a-b--1h2s"],
  ["owner/github", "owner-github"],
  ["owner/.github", "owner-github--1sd"],
  ["owner/a.", "owner-a--2d"],
  ["sakompella/sakompella.github.io", "sakompella-sakompella-github-io--2d3d"],
])("gives %s its own id %s", (path, id) => {
  expect(projectIdForRepository(`https://github.com/${path}`)).toBe(id);
  expect(parseProjectId(id)).toBe(id);
});

test("gives the longest names GitHub allows an id, unless punctuation makes it too long", () => {
  const owner = "o".repeat(39);
  const hyphenated = `${"o-".repeat(19)}o`;
  const name = "r".repeat(100);

  expect(projectIdForRepository(`https://github.com/${owner}/${name}`)).toHaveLength(140);

  for (const url of [
    `https://github.com/${hyphenated}/${name}`,
    `https://github.com/${hyphenated}/${"r".repeat(90)}.${"s".repeat(9)}`,
  ]) {
    const id = projectIdForRepository(url);

    expect(id).toBeDefined();
    expect(id?.length).toBeLessThanOrEqual(PROJECT_ID_LIMIT);
  }
});

test.each([
  ["another host", "https://gitlab.com/owner/repo"],
  ["a path deeper than owner and repository", "https://github.com/owner/repo/tree"],
  ["an owner GitHub cannot have", "https://github.com/-/harness"],
  ["an owner with a dot", "https://github.com/own.er/repo"],
  ["a repository name with a percent escape", "https://github.com/owner/a%2Fb"],
  ["an owner longer than GitHub allows", `https://github.com/${"o".repeat(40)}/repo`],
  ["a repository name longer than GitHub allows", `https://github.com/owner/${"r".repeat(101)}`],
  [
    "a name whose id would not fit in a directory name",
    `https://github.com/owner/${"a.".repeat(50)}`,
  ],
])("derives no id for %s", (_, url) => {
  expect(projectIdForRepository(url)).toBeUndefined();
});
