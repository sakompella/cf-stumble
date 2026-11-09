import type { HarnessCommit } from "./harness-commit.js";
import type { ProjectId } from "./project-catalog.js";
import type { SelectableProject } from "./selectable-projects.js";

export const WORKSPACE_ROOT = "/workspace";

export const WORKSPACE_SYNC_IGNORES = ["node_modules"] as const;

export const HARNESS_DIRECTORY = `${WORKSPACE_ROOT}/harness`;

export const HARNESS_GIT_DIRECTORY = `${HARNESS_DIRECTORY}/.git`;

export const PROJECTS_DIRECTORY = `${WORKSPACE_ROOT}/projects`;

export const BUILD_SCRATCH_ROOT = "/tmp/cf-stumble-builds";

export const HARNESS_BUILD_OUTPUT_DIRECTORY = `${WORKSPACE_ROOT}/.cf-stumble-build-output`;

export const WORKSPACE_SPILL_DIRECTORY = `${WORKSPACE_ROOT}/.cf-stumble/tmp`;

export function harnessBuildOutputPath(harnessCommit: HarnessCommit): string {
  return `${HARNESS_BUILD_OUTPUT_DIRECTORY}/${harnessCommit}.json`;
}

export const MANAGED_AGENT_INSTRUCTIONS_PATH = `${WORKSPACE_ROOT}/AGENTS.md`;

export const GITHUB_CLI_CONFIG_DIRECTORY = `${WORKSPACE_ROOT}/.config/gh`;

export const GIT_GLOBAL_CONFIG_PATH = `${WORKSPACE_ROOT}/.gitconfig`;

export function projectDirectory(projectId: ProjectId): string {
  return `${PROJECTS_DIRECTORY}/${projectId}`;
}

export function projectGitDirectory(projectId: ProjectId): string {
  return `${projectDirectory(projectId)}/.git`;
}

export function selectedWorkingDirectory(project: SelectableProject): string {
  return project.kind === "harness" ? HARNESS_DIRECTORY : projectDirectory(project.id);
}
