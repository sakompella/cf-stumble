import { expect, test } from "vitest";
import { resolveProject } from "../src/project-catalog.js";
import { HARNESS_PROJECT, selectableCatalog } from "../src/selectable-projects.js";
import {
  HARNESS_DIRECTORY,
  projectDirectory,
  selectedWorkingDirectory,
} from "../src/workspace-layout.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "./project-fixtures.js";

test("offers the harness after the connected repositories, also when none is connected", () => {
  const nothingConnected = selectableCatalog([]);
  const withRepositories = selectableCatalog(sampleCatalog);

  expect(nothingConnected).toEqual([HARNESS_PROJECT]);
  expect(withRepositories.map((project) => project.id)).toEqual([
    sampleProjectOne.id,
    sampleProjectTwo.id,
    HARNESS_PROJECT.id,
  ]);
  expect(withRepositories.at(0)).toEqual({ kind: "repository", ...sampleProjectOne });
});

test("resolves a selected id to a working directory, and an unknown one to nothing", () => {
  const catalog = selectableCatalog(sampleCatalog);

  const harness = resolveProject(HARNESS_PROJECT.id, catalog);
  const project = resolveProject(sampleProjectOne.id, catalog);

  expect(harness).toEqual({ ok: true, project: HARNESS_PROJECT });
  expect(project.ok && selectedWorkingDirectory(project.project)).toBe(
    projectDirectory(sampleProjectOne.id),
  );
  expect(harness.ok && selectedWorkingDirectory(harness.project)).toBe(HARNESS_DIRECTORY);
  expect(resolveProject("not-connected", catalog)).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
  expect(resolveProject("Not A Project Id", catalog)).toEqual({
    ok: false,
    reason: "invalid-project-id",
  });
});
