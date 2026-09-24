import { expect, test } from "vitest";
import {
  canonicalRepositoryUrl,
  EMPTY_PROJECT_CATALOG,
  parseProjectCatalog,
  parseProjectId,
  PROJECT_ID_LIMIT,
  projectIdForRepository,
  resolveProject,
  type ProjectCatalog,
} from "../src/project-catalog.js";
import { projectDirectory } from "../src/workspace-layout.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "./project-fixtures.js";

/**
 * The catalog is a variable-length collection of the repositories one tenant has connected. These
 * tests hold the three properties a connect flow needs from it: any number of projects resolves,
 * identity does not depend on position or display name, and connecting the same repository twice
 * names the same project.
 */

function catalogOf(...urls: readonly string[]): ProjectCatalog {
  const parsed = parseProjectCatalog(
    urls.map((repositoryUrl, index) => ({
      id: projectIdForRepository(repositoryUrl),
      displayName: `project ${index}`,
      repositoryUrl,
    })),
  );

  if (parsed === undefined) {
    throw new Error("these repository URLs must produce a catalog");
  }

  return parsed;
}

test("ships no projects, because a project exists only once a tenant connects one", () => {
  expect(EMPTY_PROJECT_CATALOG).toEqual([]);
  expect(resolveProject("sample-project-one")).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
});

test.each([0, 1, 2, 3])("resolves every project of a catalog holding %i of them", (count) => {
  const urls = Array.from(
    { length: count },
    (_, index) => `https://github.com/sample/repo-${index}`,
  );

  const catalog = catalogOf(...urls);

  expect(catalog).toHaveLength(count);

  for (const project of catalog) {
    expect(resolveProject(project.id, catalog)).toEqual({ ok: true, project });
  }

  expect(resolveProject("not-connected", catalog)).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
});

test("gives one repository the same identity whatever its position or display name", () => {
  const url = "https://github.com/sample/repo-1";
  const first = catalogOf(url, "https://github.com/sample/repo-2");
  const reordered = catalogOf("https://github.com/sample/repo-2", url);

  const renamed = parseProjectCatalog([
    { id: projectIdForRepository(url), displayName: "a new name", repositoryUrl: url },
  ]);

  expect(projectIdForRepository(url)).toBe("sample-repo-1");
  expect(resolveProject("sample-repo-1", first)).toMatchObject({ ok: true });
  expect(resolveProject("sample-repo-1", reordered)).toMatchObject({ ok: true });
  expect(renamed?.[0]?.id).toBe("sample-repo-1");
});

test.each([
  "https://github.com/Sample/Repo-1.git",
  "https://GitHub.com/Sample/Repo-1",
  "https://github.com/Sample/Repo-1/",
])("converges %s on one canonical repository and one project id", (written) => {
  expect(canonicalRepositoryUrl(written)).toBe("https://github.com/Sample/Repo-1");
  expect(projectIdForRepository(written)).toBe("sample-repo-1");
});

test("refuses a repository URL that no clone could use", () => {
  expect(canonicalRepositoryUrl("http://github.com/sample/repo")).toBeUndefined();
  expect(canonicalRepositoryUrl("https://token@github.com/sample/repo")).toBeUndefined();
  expect(canonicalRepositoryUrl("https://github.com/sample")).toBeUndefined();
  expect(projectIdForRepository("not a url")).toBeUndefined();
  expect(projectIdForRepository("https://github.com/--/--")).toBeUndefined();
});

test("keeps the id of every connected repository whose name has no dot or underscore", () => {
  // The owner's live project. Its thread, its SQLite rows, and its directory under
  // /workspace/projects are all keyed by this id, so the id may never change.
  expect(projectIdForRepository("https://github.com/sakompella/emaily-demo")).toBe(
    "sakompella-emaily-demo",
  );
  expect(projectIdForRepository("https://GitHub.com/Sakompella/Emaily-Demo.git/")).toBe(
    "sakompella-emaily-demo",
  );
  expect(projectIdForRepository("https://github.com/sample/repo-1")).toBe("sample-repo-1");
  expect(projectIdForRepository("https://github.com/octocat/hello-world")).toBe(
    "octocat-hello-world",
  );
});

test.each([
  ["owner/a-b", "owner-a-b"],
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

test("gives repositories that differ only in punctuation different ids", () => {
  const paths = [
    "owner/a-b",
    "owner/a.b",
    "owner/a_b",
    "owner/a--b",
    "owner/a-.b",
    "owner/a-b-",
    "owner/-a-b",
    "owner-a/b",
    "owner/github",
    "owner/.github",
  ];

  const ids = paths.map((path) => projectIdForRepository(`https://github.com/${path}`));

  expect(ids).not.toContain(undefined);
  expect(new Set(ids).size).toBe(paths.length);
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

test("gives one repository one id whatever the case of its owner and name", () => {
  // GitHub resolves owner and repository names without regard to case, so these are one
  // repository and must be one project.
  expect(projectIdForRepository("https://github.com/Owner/A.B")).toBe(
    projectIdForRepository("https://github.com/owner/a.b"),
  );
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

test("gives two connected projects different directories in the one workspace", () => {
  expect(projectDirectory(sampleProjectOne.id)).not.toBe(projectDirectory(sampleProjectTwo.id));
  expect(projectDirectory(sampleProjectOne.id)).toBe(projectDirectory(sampleProjectOne.id));
});

test("refuses a malformed or ambiguous catalog", () => {
  expect(
    parseProjectCatalog([
      {
        id: "project-one",
        displayName: "Project one",
        repositoryUrl: "http://example.invalid/project-one.git",
      },
    ]),
    "an insecure repository URL",
  ).toBeUndefined();
  expect(
    parseProjectCatalog([sampleProjectOne, sampleProjectOne]),
    "two rows with one id would make resolution depend on position",
  ).toBeUndefined();
  expect(parseProjectCatalog(sampleCatalog)).toEqual(sampleCatalog);
});
