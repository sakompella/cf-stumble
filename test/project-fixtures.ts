import {
  canonicalRepositoryUrl,
  defaultProjectDisplayName,
  parseProjectId,
  projectIdForRepository,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../src/project-catalog.js";

export function projectOf(repositoryUrl: string): Project {
  const id = projectIdForRepository(repositoryUrl);
  const url = canonicalRepositoryUrl(repositoryUrl);

  if (id === undefined || url === undefined) throw new Error(`${repositoryUrl} must be a project`);

  return { id, displayName: defaultProjectDisplayName(url), repositoryUrl: url };
}

export const sampleProjectOne: Project = projectOf("https://github.com/sample/project-one");

export const sampleProjectTwo: Project = projectOf("https://github.com/sample/project-two");

export const sampleCatalog: ProjectCatalog = [sampleProjectOne, sampleProjectTwo];

export function projectIdOf(value: string): ProjectId {
  const projectId = parseProjectId(value);

  if (projectId === undefined) throw new Error(`${value} must be a project id`);

  return projectId;
}
