import { expect, test } from "vitest";
import {
  PROJECT_CATALOG,
  PROJECT_CATALOG_CONFIGURATION,
  parseProjectCatalog,
} from "../src/project-catalog.js";
import { resolveProject } from "../src/project-catalog.js";
import { projectDirectory } from "../src/workspace-layout.js";

test("configures exactly two projects with validated repository URLs", () => {
  expect(PROJECT_CATALOG).toHaveLength(2);
  expect(parseProjectCatalog(PROJECT_CATALOG_CONFIGURATION)).toEqual(PROJECT_CATALOG);
  expect(
    PROJECT_CATALOG.every((project) => project.repositoryUrl.includes("example.invalid")),
  ).toBe(true);
});

test("gives the two configured projects different directories in the one workspace", () => {
  expect(projectDirectory(PROJECT_CATALOG[0].id)).not.toBe(projectDirectory(PROJECT_CATALOG[1].id));
  expect(projectDirectory(PROJECT_CATALOG[0].id)).toBe(projectDirectory(PROJECT_CATALOG[0].id));
});

test("rejects an unknown client-supplied project id before naming a directory", () => {
  expect(resolveProject("client-supplied-project")).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
});

test("rejects malformed repository configuration", () => {
  expect(
    parseProjectCatalog([
      {
        id: "project-one",
        displayName: "Project one",
        repositoryUrl: "http://example.invalid/project-one.git",
      },
      PROJECT_CATALOG_CONFIGURATION[1],
    ]),
  ).toBeUndefined();
});
