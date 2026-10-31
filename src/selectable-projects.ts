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

type SelectableResolution =
  | Readonly<{ ok: true; project: SelectableProject }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

export function resolveSelectableProject(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: this is the parser. A selected id arrives from a client with no proven shape.
  projectId: unknown,
  catalog: SelectableCatalog,
): SelectableResolution {
  const parsedProjectId = parseProjectId(projectId);

  if (parsedProjectId === undefined) {
    return { ok: false, reason: "invalid-project-id" };
  }

  const project = catalog.find((candidate) => candidate.id === parsedProjectId);

  return project === undefined
    ? { ok: false, reason: "unknown-project-id" }
    : { ok: true, project };
}
