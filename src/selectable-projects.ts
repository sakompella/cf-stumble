import { invariant } from "./invariant.js";
import {
  parseProjectId,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "./project-catalog.js";

/**
 * What the owner may select in the sidebar, and the one place the harness becomes one of them.
 *
 * A connected repository and the harness checkout are two directories of the one workspace the
 * tenant owns (ADR-0038), and selecting either does exactly one thing: it decides the directory
 * the next turn starts in (`workspace-layout.ts`). This module states that as one union, so the
 * thread surface, the turn path and the page all read one list and resolve one id space.
 *
 * `project-catalog.ts` keeps what a *connection* is — a canonical repository URL, an id derived
 * from it, the parsing a stored row goes through. Nothing here parses anything: the harness entry
 * is a constant, and a repository entry is a catalog row it has already produced.
 */

/**
 * The harness entry's id.
 *
 * It is a fixed word rather than a derived one, because nothing about the harness comes from a
 * repository the tenant connected: the checkout is already in the workspace, and the entry exists
 * before anything is connected and after everything is disconnected. `connected_projects` refuses
 * this id (`connected-projects.ts`), so one id never names two selectable things.
 */
export const HARNESS_PROJECT_ID: ProjectId = harnessProjectId();

function harnessProjectId(): ProjectId {
  const parsed = parseProjectId("harness");
  invariant(parsed !== undefined, "the harness project id must be a project id");
  return parsed;
}

/**
 * The harness checkout as the sidebar offers it: a working directory and nothing else.
 *
 * It carries no repository URL because it has none to carry. That absence is the type's job: a
 * caller that wants to clone, to check GitHub access, or to provision has to narrow to
 * {@link RepositoryProject} first, so no code path can ask the harness entry for a connection it
 * was never going to have.
 */
export type HarnessProject = Readonly<{ kind: "harness"; id: ProjectId; displayName: string }>;

/** One connected repository, as the same sidebar offers it. */
export type RepositoryProject = Project & Readonly<{ kind: "repository" }>;

/**
 * What the owner may select to work in: one of the connected repositories, or the harness.
 *
 * This is one union rather than a project list and a separate harness flag, because selection is
 * one act with one consequence — the turn's working directory (`workspace-layout.ts`) — and every
 * consumer between the sidebar and that directory should be unable to forget the second case. A
 * boolean on `Project` would have made a repository-less repository representable, and a second
 * list would have made a thread, a lease, and a turn each answer to two lookups.
 */
export type SelectableProject = HarnessProject | RepositoryProject;

/** Everything the tenant may select, in the order the sidebar shows it. */
export type SelectableCatalog = readonly SelectableProject[];

/** The harness entry itself. There is one, it needs no connection, and it is always present. */
export const HARNESS_PROJECT: HarnessProject = Object.freeze({
  kind: "harness",
  id: HARNESS_PROJECT_ID,
  displayName: "harness",
});

function repositoryProject(project: Project): RepositoryProject {
  return Object.freeze({ kind: "repository", ...project });
}

/**
 * The tenant's connected repositories plus the harness, which is the whole of what a client id may
 * name.
 *
 * The harness comes last so the page's default selection is still the first repository the owner
 * connected; a tenant that has connected nothing selects the harness because it is the only entry
 * there is.
 */
export function selectableCatalog(projects: ProjectCatalog): SelectableCatalog {
  return Object.freeze([...projects.map((project) => repositoryProject(project)), HARNESS_PROJECT]);
}

export type SelectableResolution =
  | Readonly<{ ok: true; project: SelectableProject }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

/**
 * Turn a client-supplied id into one of the tenant's selectable projects.
 *
 * Every client-facing surface — the thread, the fresh-thread reset, the turn — goes through this
 * one function, so an id the catalog does not hold is `unknown-project-id` there as it always was.
 * The catalog is an argument rather than a default, because the harness entry is the one thing
 * that exists without being connected and a caller that forgot to pass a catalog would otherwise
 * quietly resolve it.
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
