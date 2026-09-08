import { expect, test } from "vitest";
import { EMPTY_PROJECT_CATALOG } from "../src/project-catalog.js";
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

/**
 * What the owner may select, and what selecting it means.
 *
 * The harness entry is the one selectable thing nobody connects, so these tests hold the two
 * properties the rest of the program leans on: it is always in the catalog and carries no
 * repository URL, and a selected id becomes a working directory in the tenant's one workspace or
 * becomes nothing at all.
 */

test("offers the harness with no connection behind it, connected repositories or not", () => {
  const nothingConnected = selectableCatalog(EMPTY_PROJECT_CATALOG);
  const withRepositories = selectableCatalog(sampleCatalog);

  // The harness entry exists before anyone connects anything and carries no repository URL, so
  // nothing can ask it for a clone or an authorization. It comes last, which leaves the page's
  // default selection on the first repository the owner connected.
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
  expect(resolveSelectableProject({ id: "harness" }, catalog)).toEqual({
    ok: false,
    reason: "invalid-project-id",
  });
});
