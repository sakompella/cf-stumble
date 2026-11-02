const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--(?:[1-9][0-9]*[dhsu]+)+)?$/u;

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

function isProjectId(value: string): value is ProjectId {
  return value.length <= PROJECT_ID_LIMIT && projectIdPattern.test(value);
}

export function parseProjectId(value: string): ProjectId | undefined {
  return isProjectId(value) ? value : undefined;
}

function isPublicRepositoryUrl(value: string): value is PublicRepositoryUrl {
  const url = URL.parse(value);

  return (
    url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.hostname !== "" &&
    url.pathname.split("/").filter((segment) => segment.length > 0).length >= 2
  );
}

export function parsePublicRepositoryUrl(value: string): PublicRepositoryUrl | undefined {
  return isPublicRepositoryUrl(value) ? value : undefined;
}

export function canonicalRepositoryUrl(value: string): PublicRepositoryUrl | undefined {
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

const githubOwnerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/u;

const githubRepositoryPattern = /^[a-z0-9._-]{1,100}$/u;

function separatorCode(separator: string): string {
  return separator
    .replaceAll("/", "s")
    .replaceAll("-", "h")
    .replaceAll(".", "d")
    .replaceAll("_", "u");
}

export function projectIdForRepository(repositoryUrl: string): ProjectId | undefined {
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

type ProjectResolution =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

export function resolveProject(projectId: string, catalog: ProjectCatalog): ProjectResolution {
  const parsedProjectId = parseProjectId(projectId);

  if (parsedProjectId === undefined) {
    return { ok: false, reason: "invalid-project-id" };
  }

  const project = catalog.find((candidate) => candidate.id === parsedProjectId);

  return project === undefined
    ? { ok: false, reason: "unknown-project-id" }
    : { ok: true, project };
}
