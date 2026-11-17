import { invariant } from "./invariant.js";
import {
  parseProjectId,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "./project-catalog.js";

export const HARNESS_PROJECT_ID: ProjectId = harnessProjectId();

function harnessProjectId(): ProjectId {
  const parsed = parseProjectId("harness");
  invariant(parsed !== undefined, "the harness project id must be a project id");

  return parsed;
}

type HarnessProject = Readonly<{ kind: "harness"; id: ProjectId; displayName: string }>;

type RepositoryProject = Project & Readonly<{ kind: "repository" }>;

export type SelectableProject = HarnessProject | RepositoryProject;

export type SelectableCatalog = readonly SelectableProject[];

export const HARNESS_PROJECT: HarnessProject = Object.freeze({
  kind: "harness",
  id: HARNESS_PROJECT_ID,
  displayName: "harness",
});

function repositoryProject(project: Project): RepositoryProject {
  return Object.freeze({ kind: "repository", ...project });
}

export function selectableCatalog(projects: ProjectCatalog): SelectableCatalog {
  return Object.freeze([...projects.map((project) => repositoryProject(project)), HARNESS_PROJECT]);
}
