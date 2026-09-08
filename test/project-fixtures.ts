import { parseProjectCatalog, type Project, type ProjectCatalog } from "../src/project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../src/selectable-projects.js";

/**
 * A tenant that has connected two repositories, for the tests that need projects to exist.
 *
 * The catalog is runtime state now: `src/project-catalog.ts` ships no projects, because a
 * repository is a project only once someone connects it. Tests that used to lean on two
 * placeholder entries in the source lean on this fixture instead, so a test never proves
 * something about a catalog no deployment has.
 */
const parsed = parseProjectCatalog([
  {
    id: "sample-project-one",
    displayName: "sample/project-one",
    repositoryUrl: "https://github.com/sample/project-one",
  },
  {
    id: "sample-project-two",
    displayName: "sample/project-two",
    repositoryUrl: "https://github.com/sample/project-two",
  },
]);
if (parsed === undefined || parsed[0] === undefined || parsed[1] === undefined) {
  throw new Error("the sample catalog must parse");
}

export const sampleCatalog: ProjectCatalog = parsed;
export const sampleProjectOne: Project = parsed[0];
export const sampleProjectTwo: Project = parsed[1];

/**
 * The same tenant as the sidebar and the turn path see it: the two connected repositories and the
 * harness entry, which is there without anyone connecting it.
 */
export const sampleSelectableCatalog: SelectableCatalog = selectableCatalog(sampleCatalog);
