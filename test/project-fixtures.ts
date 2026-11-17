import {
  parseProject,
  parseProjectId,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../src/project-catalog.js";

export function projectOf(repositoryUrl: string): Project {
  const project = parseProject(repositoryUrl);

  if (project === undefined) throw new Error(`${repositoryUrl} must be a project`);

  return project;
}

export const sampleProjectOne: Project = projectOf("https://github.com/sample/project-one");

export const sampleProjectTwo: Project = projectOf("https://github.com/sample/project-two");

export const sampleCatalog: ProjectCatalog = [sampleProjectOne, sampleProjectTwo];

export function projectIdOf(value: string): ProjectId {
  const projectId = parseProjectId(value);

  if (projectId === undefined) throw new Error(`${value} must be a project id`);

  return projectId;
}
