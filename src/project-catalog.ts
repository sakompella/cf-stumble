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

export type ProjectCatalog = readonly [Project, Project];

export type ProjectConfiguration = Readonly<{
  id: string;
  displayName: string;
  repositoryUrl: string;
}>;

export const PROJECT_CATALOG_CONFIGURATION = Object.freeze([
  Object.freeze({
    id: "project-one",
    displayName: "Project one",
    repositoryUrl: "https://example.invalid/placeholder/project-one.git",
  }),
  Object.freeze({
    id: "project-two",
    displayName: "Project two",
    repositoryUrl: "https://example.invalid/placeholder/project-two.git",
  }),
] as const satisfies readonly [ProjectConfiguration, ProjectConfiguration]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseProjectCatalog(value: unknown): ProjectCatalog | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }

  const first = parseProject(value[0]);
  const second = parseProject(value[1]);
  if (first === undefined || second === undefined || first.id === second.id) {
    return undefined;
  }

  return Object.freeze([Object.freeze(first), Object.freeze(second)]);
}

const parsedProjectCatalog = parseProjectCatalog(PROJECT_CATALOG_CONFIGURATION);
if (parsedProjectCatalog === undefined) {
  throw new Error("the project catalog configuration is invalid");
}

export const PROJECT_CATALOG: ProjectCatalog = parsedProjectCatalog;

export type ProjectResolution =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

export function resolveProject(
  projectId: unknown,
  catalog: ProjectCatalog = PROJECT_CATALOG,
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
