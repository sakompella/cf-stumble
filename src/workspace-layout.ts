import type { ProjectId } from "./project-catalog.js";
import type { SelectableProject } from "./selectable-projects.js";

/**
 * The project path resolver and the facet's path-escape guard both read `WORKSPACE_ROOT` from here;
 * two definitions could let address translation and the escape check disagree about the sandbox.
 */

export const WORKSPACE_ROOT = "/workspace";

/**
 * A dependency tree of tens of thousands of files wedges every later sync; computerd honors
 * `ignore` as a per-call path-segment filter.
 */
export const WORKSPACE_SYNC_IGNORES = ["node_modules"] as const;

export const HARNESS_DIRECTORY = `${WORKSPACE_ROOT}/harness`;

export const HARNESS_GIT_DIRECTORY = `${HARNESS_DIRECTORY}/.git`;

/** One level down so a project id can never collide with the harness directory or build scratch. */
export const PROJECTS_DIRECTORY = `${WORKSPACE_ROOT}/projects`;

/**
 * The container's own filesystem, not the workspace: everything under `WORKSPACE_ROOT` is durable
 * and
 * routed through the hosting Durable Object, and installing about fifty thousand files there reset
 * it
 * mid-build. Computer validates a command's working directory against the workspace, so build steps
 * run inside the workspace and name this path in the command.
 * Builds write only `<commit>` below it, so their `rm -rf` cannot name the harness or a project.
 */
export const BUILD_SCRATCH_ROOT = "/tmp/cf-stumble-builds";

/**
 * Above every repository so the file neither overwrites a repository's own `AGENTS.md` nor shows up
 * in a diff the user reviews.
 */
export const MANAGED_AGENT_INSTRUCTIONS_PATH = `${WORKSPACE_ROOT}/AGENTS.md`;

/**
 * Under the workspace root because Computer persists only that tree; a path under `$HOME`
 * disappears when the container is replaced.
 */
export const GITHUB_CLI_CONFIG_DIRECTORY = `${WORKSPACE_ROOT}/.config/gh`;

/** Under the root for the same reason; `gh auth setup-git` writes the helper here. */
export const GIT_GLOBAL_CONFIG_PATH = `${WORKSPACE_ROOT}/.gitconfig`;

/** A `ProjectId` has no dot that could name a sibling staging directory. */
export function projectDirectory(projectId: ProjectId): string {
  return `${PROJECTS_DIRECTORY}/${projectId}`;
}

export function projectGitDirectory(projectId: ProjectId): string {
  return `${projectDirectory(projectId)}/.git`;
}

export function selectedWorkingDirectory(project: SelectableProject): string {
  return project.kind === "harness" ? HARNESS_DIRECTORY : projectDirectory(project.id);
}
