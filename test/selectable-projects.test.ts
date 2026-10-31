import { expect, test } from "vitest";
import {
  HARNESS_PROJECT,
  resolveSelectableProject,
  selectableCatalog,
} from "../src/selectable-projects.js";
import {
  HARNESS_DIRECTORY,
  projectDirectory,
  selectedWorkingDirectory,
} from "../src/workspace-layout.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "./project-fixtures.js";

test("offers the harness with no connection behind it, connected repositories or not", () => {
  const nothingConnected = selectableCatalog([]);
  const withRepositories = selectableCatalog(sampleCatalog);

  expect(nothingConnected).toEqual([HARNESS_PROJECT]);
  expect(HARNESS_PROJECT).not.toHaveProperty("repositoryUrl");
  expect(withRepositories.map((project) => project.id)).toEqual([
    sampleProjectOne.id,
    sampleProjectTwo.id,
    HARNESS_PROJECT.id,
  ]);
  expect(withRepositories.at(0)).toEqual({ kind: "repository", ...sampleProjectOne });
});

test("resolves a selected id to a working directory, and an unknown one to nothing", () => {
  const catalog = selectableCatalog(sampleCatalog);

  const harness = resolveSelectableProject(HARNESS_PROJECT.id, catalog);
  const project = resolveSelectableProject(sampleProjectOne.id, catalog);

  expect(harness).toEqual({ ok: true, project: HARNESS_PROJECT });
  expect(project.ok && selectedWorkingDirectory(project.project)).toBe(
    projectDirectory(sampleProjectOne.id),
  );
  expect(harness.ok && selectedWorkingDirectory(harness.project)).toBe(HARNESS_DIRECTORY);
  expect(resolveSelectableProject("not-connected", catalog)).toEqual({
    ok: false,
    reason: "unknown-project-id",
  });
  expect(resolveSelectableProject("Not A Project Id", catalog)).toEqual({
    ok: false,
    reason: "invalid-project-id",
  });
});
