import { invariant } from "./invariant.js";
import {
  parseProjectId,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "./project-catalog.js";

/** `connected_projects` refuses this id, so one id never names two selectable things. */
export const HARNESS_PROJECT_ID: ProjectId = harnessProjectId();

function harnessProjectId(): ProjectId {
  const parsed = parseProjectId("harness");
  invariant(parsed !== undefined, "the harness project id must be a project id");

  return parsed;
}

/** No repository URL: a caller that needs one must narrow to {@link RepositoryProject}. */
type HarnessProject = Readonly<{ kind: "harness"; id: ProjectId; displayName: string }>;

type RepositoryProject = Project & Readonly<{ kind: "repository" }>;

/**
 * One union rather than a harness flag on `Project`, so no consumer can forget the repository-less
 * case.
 */
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

/** The harness comes last so the default selection is still the first connected repository. */
export function selectableCatalog(projects: ProjectCatalog): SelectableCatalog {
  return Object.freeze([...projects.map((project) => repositoryProject(project)), HARNESS_PROJECT]);
}

type SelectableResolution =
  | Readonly<{ ok: true; project: SelectableProject }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

/**
 * The catalog is an argument, not a default: a caller that forgot it would quietly resolve the
 * harness, which exists without being connected.
 */
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
