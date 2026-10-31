import { parseProjectCatalog, type Project, type ProjectCatalog } from "../src/project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../src/selectable-projects.js";

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

export const sampleSelectableCatalog: SelectableCatalog = selectableCatalog(sampleCatalog);
