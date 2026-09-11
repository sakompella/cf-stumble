import { expect, test } from "vitest";
import {
  canonicalRepositoryUrl,
  EMPTY_PROJECT_CATALOG,
  parseProjectCatalog,
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
