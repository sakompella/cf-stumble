import type { ProjectId } from "./project-catalog.js";
import type { SelectableProject } from "./selectable-projects.js";

/**
 * Where every repository lives inside the one Computer workspace a tenant owns (ADR-0038).
 *
 * This module is the single owner of the repository-relative root. Both the project RPC target's
 * addressed-path space (`workspace/project/resolve.ts`) and the facet's path-escape guard
 * (`facet/generation-0/execution-env-paths.ts`) read {@link WORKSPACE_ROOT} from here, because two
 * definitions of one root is a security divergence rather than a duplicated constant: if they
 * drift, address translation and the escape check disagree about what is inside the sandbox.
 *
 * The workspace is a development machine (ADR-0039), so the layout is the ordinary one a developer
 * would keep: the harness repository and each connected project repository are sibling directories
 * with their own Git histories, the managed instructions sit beside them, and build scratch is a
 * separate subtree that no repository is ever inside.
 *
 * It holds plain values only and imports no platform API.
 */

/** The root of the tenant's shared workspace. Every addressed path lives beneath it. */
export const WORKSPACE_ROOT = "/workspace";

/** The owner's harness repository: an ordinary editable checkout, not build scratch. */
export const HARNESS_DIRECTORY = `${WORKSPACE_ROOT}/harness`;

export const HARNESS_GIT_DIRECTORY = `${HARNESS_DIRECTORY}/.git`;

/**
 * The parent of every connected project's clone. Projects live one level down rather than directly
 * under the root so a project id can never collide with {@link HARNESS_DIRECTORY} or with build
 * scratch, whatever the catalog names a project.
 */
export const PROJECTS_DIRECTORY = `${WORKSPACE_ROOT}/projects`;

/**
 * Where a build extracts a labeled commit: the container's own filesystem, not the workspace.
 *
 * Everything under `WORKSPACE_ROOT` is durable, and Computer routes it through the Durable Object
 * that hosts the workspace. A build installs 186 packages, about fifty thousand files, and doing
 * that inside the workspace reset the Durable Object mid-build ("Durable Object connection closed
 * because the object was reset"), which reached the browser as `build-workspace-unavailable`. The
 * deployed builds that survived took eleven to twenty-one minutes and left the workspace so large
 * that an ordinary two second command took over five minutes afterwards.
 *
 * A build needs scratch space, not durable space. Computer validates a command's working directory
 * against the workspace, so every build step runs with a working directory inside the workspace and
 * names this path in the command itself.
 *
 * A build still writes only `${BUILD_SCRATCH_ROOT}/<commit>`, where a commit is forty hexadecimal
 * characters, so its own `rm -rf` can name neither the harness checkout nor a project clone. The
 * directory belongs to the tenant's own container, so this moves no boundary.
 */
export const BUILD_SCRATCH_ROOT = "/tmp/cf-stumble-builds";

/**
 * The instructions cf-stumble manages for the whole workspace.
 *
 * It sits above every repository on purpose. The clones own their own directories, so a managed
 * file written inside one would either overwrite a repository that keeps its own `AGENTS.md` or
 * show up as a working-tree change in the diff the user reviews. A parent of every clone is the
 * nearest place an agent that walks up from its working directory still reaches, and it never
 * becomes part of a repository.
 */
export const MANAGED_AGENT_INSTRUCTIONS_PATH = `${WORKSPACE_ROOT}/AGENTS.md`;

/** One project's clone. The id is a `ProjectId`, so it is one lower-case dash-separated segment. */
export function projectDirectory(projectId: ProjectId): string {
  return `${PROJECTS_DIRECTORY}/${projectId}`;
}

/** One project's Git directory, named rather than assembled again at each call site. */
export function projectGitDirectory(projectId: ProjectId): string {
  return `${projectDirectory(projectId)}/.git`;
}

/**
 * Where a turn starts when the owner selects something in the sidebar.
 *
 * This is the whole of what selecting does (ADR-0038): the harness entry is the harness checkout,
 * a connected repository is that repository's clone, and both are directories of the one workspace
 * the tenant owns. Nothing else about the two selections differs, so this is the only function in
 * the program that has to know they are two, and every caller works in the directory it returns.
 */
export function selectedWorkingDirectory(project: SelectableProject): string {
  return project.kind === "harness" ? HARNESS_DIRECTORY : projectDirectory(project.id);
}
