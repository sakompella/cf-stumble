// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- Catalog configuration and project selection are parsed at these boundaries.

const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

declare const projectIdBrand: unique symbol;
declare const repositoryUrlBrand: unique symbol;

export type ProjectId = string & {
  readonly [projectIdBrand]: "ProjectId";
};

export type PublicRepositoryUrl = string & {
  readonly [repositoryUrlBrand]: "PublicRepositoryUrl";
};

export type Project = Readonly<{
  id: ProjectId;
  displayName: string;
  repositoryUrl: PublicRepositoryUrl;
}>;

/**
 * Every repository this tenant has connected, in the order the tenant connected them.
 *
 * This is a variable-length collection rather than the fixed pair it used to be, because a
 * connected project is now runtime state: the tenant connects a first repository, a second, a
 * third, and disconnects one, and none of those is a type change. Nothing here depends on the
 * order or the length. {@link resolveProject} is the one way a client string becomes a project,
 * so a consumer that holds a catalog holds a set of projects it may address and nothing else.
 */
export type ProjectCatalog = readonly Project[];

/** The catalog of a tenant that has connected nothing yet. Resolving anything against it fails. */
export const EMPTY_PROJECT_CATALOG: ProjectCatalog = Object.freeze([]);

export type ProjectConfiguration = Readonly<{
  id: string;
  displayName: string;
  repositoryUrl: string;
}>;

export function parseProjectId(value: unknown): ProjectId | undefined {
  if (typeof value !== "string" || !projectIdPattern.test(value)) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: projectIdPattern accepts exactly the ProjectId syntax.
  return value as ProjectId;
}

export function parsePublicRepositoryUrl(value: unknown): PublicRepositoryUrl | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === "" ||
    pathSegments.length < 2
  ) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the URL checks accept only repository URL syntax.
  return value as PublicRepositoryUrl;
}

/**
 * The one spelling of a repository URL cf-stumble keeps.
 *
 * A user pastes `https://GitHub.com/Owner/Repo.git`, `.../Owner/Repo`, or either with a trailing
 * slash, and means one repository every time. Provisioning compares the stored URL against
 * `remote.origin.url` verbatim, and project identity is derived from this spelling, so the same
 * repository has to reduce to the same string before either is decided. The path case is kept,
 * because GitHub path segments are case-preserving and a clone URL has to stay usable.
 */
export function canonicalRepositoryUrl(value: unknown): PublicRepositoryUrl | undefined {
  const parsed = parsePublicRepositoryUrl(value);
  if (parsed === undefined) {
    return undefined;
  }

  const url = new URL(parsed);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last !== undefined && last.endsWith(".git")) {
    segments[segments.length - 1] = last.slice(0, -".git".length);
  }
  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  return parsePublicRepositoryUrl(`https://${url.host}/${segments.join("/")}`);
}

/**
 * The stable identity of a connected repository: derived from its canonical URL and from nothing
 * else.
 *
 * Identity has to survive a rename of the display name and a change in list position, and
 * connecting the same repository twice has to converge on the project that is already there. A
 * counter or an insertion index would give the same repository two identities when it is
 * connected twice, and a display name would give it a new one when the user renames it. The owner
 * and repository segments are the part of the URL a person recognizes, so the id reads as the
 * repository it names rather than as an opaque key.
 *
 * Two different repositories can reduce to one id — `owner/my-repo` and `owner/my.repo` both give
 * `owner-my-repo`. The caller settles that collision by comparing the stored URL, because this
 * function decides identity and not membership.
 */
export function projectIdForRepository(repositoryUrl: unknown): ProjectId | undefined {
  const canonical = canonicalRepositoryUrl(repositoryUrl);
  if (canonical === undefined) {
    return undefined;
  }

  const segments = new URL(canonical).pathname.split("/").filter((segment) => segment.length > 0);
  const slug = segments
    .slice(-2)
    .join("-")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return parseProjectId(slug);
}

/** The name a project is shown under when the person connecting it does not choose one. */
export function defaultProjectDisplayName(repositoryUrl: PublicRepositoryUrl): string {
  const segments = new URL(repositoryUrl).pathname.split("/").filter((part) => part.length > 0);
  return segments.slice(-2).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProject(value: unknown): Project | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseProjectId(value.id);
  const repositoryUrl = parsePublicRepositoryUrl(value.repositoryUrl);
  if (
    id === undefined ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "displayName") ||
    !Object.hasOwn(value, "repositoryUrl") ||
    typeof value.displayName !== "string" ||
    value.displayName.trim().length === 0 ||
    repositoryUrl === undefined
  ) {
    return undefined;
  }

  return { id, displayName: value.displayName, repositoryUrl };
}

/**
 * Parse a whole catalog. Any length is a catalog, including none: a tenant that has connected
 * nothing is an ordinary state and not a configuration fault. Ids stay unique, because two rows
 * with one id would make `resolveProject` depend on position.
 */
export function parseProjectCatalog(value: unknown): ProjectCatalog | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const projects: Project[] = [];
  for (const entry of value) {
    const project = parseProject(entry);
    if (project === undefined || projects.some((existing) => existing.id === project.id)) {
      return undefined;
    }
    projects.push(Object.freeze(project));
  }

  return Object.freeze(projects);
}

export type ProjectResolution =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

/**
 * Turn a project id into one of the tenant's connected repositories.
 *
 * This is the resolver of the provisioning path, which needs the repository URL a clone is made
 * from and so cannot be given the harness. What a *client* selects goes through
 * {@link resolveSelectableProject} instead; by the time a project id reaches this function it has
 * already been resolved there and narrowed to a repository.
 *
 * It takes the catalog it should resolve against. The default is the empty catalog rather than a
 * built-in project list: there is no such thing as a connected repository the server knows about
 * before a tenant connects one, so a caller that forgets to supply the tenant's catalog resolves
 * nothing instead of resolving a placeholder.
 */
export function resolveProject(
  projectId: unknown,
  catalog: ProjectCatalog = EMPTY_PROJECT_CATALOG,
): ProjectResolution {
  const parsedProjectId = parseProjectId(projectId);
  if (parsedProjectId === undefined) {
    return { ok: false, reason: "invalid-project-id" };
  }

  const project = catalog.find((candidate) => candidate.id === parsedProjectId);
  return project === undefined
    ? { ok: false, reason: "unknown-project-id" }
    : { ok: true, project };
}
