// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Catalog configuration and project selection are parsed at these boundaries.

import { isRecord } from "./untrusted.js";

/** Letters, digits, and `-` only, so an id is also a path segment, a URL segment, and a key. */
const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--(?:[1-9][0-9]*[dhsu]+)+)?$/u;

/**
 * A file name may have 255 bytes and provisioning names `<id>.provisioning` and `cf-stumble-
 * project-<id>.provision.lock` from the id, so it must leave room for those.
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

export type ProjectCatalog = readonly Project[];

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
 * Provisioning compares the stored URL against `remote.origin.url` verbatim and project identity
 * derives from this spelling. Path case is kept because GitHub paths are case-preserving.
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

/** Legacy accounts may hold runs of hyphens. */
const githubOwnerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/u;

const githubRepositoryPattern = /^[a-z0-9._-]{1,100}$/u;

function separatorCode(separator: string): string {
  return separator
    .replaceAll("/", "s")
    .replaceAll("-", "h")
    .replaceAll(".", "d")
    .replaceAll("_", "u");
}

/**
 * Must be injective: the id is a directory name, a URL segment and a thread key, and `a-b`, `a.b`
 * and `a_b` are different repositories though GitHub ignores case.
 * The id is the words joined by `-`, then `--` and a punctuation key listing each unexpected
 * separator as its position plus one letter per character (`s` `/`, `h` `-`, `d` `.`, `u` `_`),
 * so `owner/a.b` is `owner-a-b--2d`.
 * A key was chosen over a hash suffix because a hash can collide and a colliding repository could
 * be
 * crafted on purpose. A name needing more than {@link PROJECT_ID_LIMIT} is refused, not shortened.
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
  // `separators[i]` stands before word `i`; `separators[0]` is always empty since the owner starts
  // with a letter or digit.
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

export function defaultProjectDisplayName(repositoryUrl: PublicRepositoryUrl): string {
  const segments = new URL(repositoryUrl).pathname.split("/").filter((part) => part.length > 0);

  return segments.slice(-2).join("/");
}

function parseProject(value: unknown): Project | undefined {
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
 * Any length is a catalog, including none. Ids stay unique so `resolveProject` does not depend on
 * position.
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

type ProjectResolution =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

/**
 * The default is the empty catalog, so a caller that forgets the tenant's catalog resolves nothing
 * instead of a placeholder.
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
