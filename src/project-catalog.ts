// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- Catalog configuration and project selection are parsed at these boundaries.

/**
 * A project id: lower-case words joined by single hyphens, optionally followed by `--` and a
 * punctuation key (see {@link projectIdForRepository}). The alphabet is letters, digits, and `-`
 * alone, so an id is the same string as a path segment, as a URL path segment, and as a key.
 */
const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--(?:[1-9][0-9]*[dhsu]+)+)?$/u;

/**
 * The longest id {@link projectIdForRepository} gives out. A directory name may have 255 bytes, and
 * provisioning names `<id>.provision-lock.stale.<pid>` beside a project's directory, so an id has
 * to leave room for that suffix. Only a repository name with dozens of dots or underscores comes
 * near it: plain GitHub names give at most 140 characters.
 */
export const PROJECT_ID_LIMIT = 200;

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
  if (
    typeof value !== "string" ||
    value.length > PROJECT_ID_LIMIT ||
    !projectIdPattern.test(value)
  ) {
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
  let last = segments.at(-1);

  while (last !== undefined && last.endsWith(".git")) {
    last = last.slice(0, -".git".length);
  }

  if (last !== undefined) {
    segments[segments.length - 1] = last;
  }

  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  return parsePublicRepositoryUrl(`https://${url.host}/${segments.join("/")}`);
}

/** GitHub owner names, compared lower case. Legacy accounts may hold runs of hyphens. */
const githubOwnerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/u;

/** GitHub repository names, compared lower case. */
const githubRepositoryPattern = /^[a-z0-9._-]{1,100}$/u;

/** The letters a separator has in a punctuation key: one per character, and never the character. */
function separatorCode(separator: string): string {
  return separator
    .replaceAll("/", "s")
    .replaceAll("-", "h")
    .replaceAll(".", "d")
    .replaceAll("_", "u");
}

/**
 * The stable identity of a connected repository: derived from its canonical URL and from nothing
 * else.
 *
 * Identity has to survive a rename of the display name and a change in list position, and
 * connecting the same repository twice has to converge on the project that is already there. A
 * counter or an insertion index would give the same repository two identities when it is
 * connected twice, and a display name would give it a new one when the user renames it.
 *
 * The id is also a directory name under `/workspace/projects`, a URL path segment, and the key of
 * the project's thread, so it has to be injective: two different repositories that shared an id
 * would share one thread and one clone directory. GitHub compares owner and repository names
 * without regard to case, but `a-b`, `a.b`, and `a_b` are three repositories. The id is built in
 * two parts from the lower-case `owner/repository`:
 *
 * - The words: every run of letters and digits, joined by single hyphens. This is the part a
 *   person reads, and it is the whole id when the name holds nothing else to record.
 * - The punctuation key, after `--`: every separator between two words that is not the expected
 *   one. The expected separator is `/` after the first word and `-` after every later word, with
 *   nothing after the last. Each entry is the separator's position (1 is the one after the first
 *   word) and one letter per character: `s` for `/`, `h` for `-`, `d` for `.`, `u` for `_`.
 *
 * So `sakompella/emaily-demo` is `sakompella-emaily-demo`, `owner/a.b` is `owner-a-b--2d`, and
 * `owner-a/b` is `owner-a-b--1h2s`. The words and the key together give back every character of
 * the lower-case name, so distinct repositories get distinct ids. An id without `--` is exactly
 * the id the earlier rule gave, so repositories whose owner has no hyphen and whose name has no
 * `.` or `_` keep the ids, threads, and directories they already had.
 *
 * An escape was chosen over a hash suffix. A hash is shorter for heavily punctuated names, but it
 * can collide, and a colliding repository could be crafted on purpose. The key is exact, and for
 * the names people use (`.github`, `my_repo`, `site.github.io`) it adds four to six characters.
 * The price is a length limit: a name with dozens of separators would give an id longer than
 * {@link PROJECT_ID_LIMIT}, and it is refused rather than shortened into an id another
 * repository could have.
 *
 * Only GitHub repositories get an id, because the naming rules above are GitHub's. Another host,
 * or a path that is not exactly `owner/repository`, derives nothing.
 */
export function projectIdForRepository(repositoryUrl: unknown): ProjectId | undefined {
  const canonical = canonicalRepositoryUrl(repositoryUrl);

  if (canonical === undefined) {
    return undefined;
  }

  const url = new URL(canonical);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const [owner, repository] = segments.map((segment) => segment.toLowerCase());

  if (
    url.hostname !== "github.com" ||
    segments.length !== 2 ||
    owner === undefined ||
    repository === undefined ||
    !githubOwnerPattern.test(owner) ||
    !githubRepositoryPattern.test(repository)
  ) {
    return undefined;
  }

  const name = `${owner}/${repository}`;
  const words = name.match(/[a-z0-9]+/gu) ?? [];
  // `separators[i]` is what stands before word `i`. The owner starts with a letter or digit, so
  // `separators[0]` is always empty, and `separators[words.length]` is whatever ends the name.
  const separators = name.split(/[a-z0-9]+/u);
  let key = "";

  for (let position = 1; position <= words.length; position += 1) {
    const separator = separators[position] ?? "";
    const expected = position === words.length ? "" : position === 1 ? "/" : "-";

    if (separator !== expected) {
      key += `${position}${separatorCode(separator)}`;
    }
  }

  const slug = words.join("-");

  return parseProjectId(key.length === 0 ? slug : `${slug}--${key}`);
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
