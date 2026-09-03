/**
 * The Workspace Host names the server derives for itself. A name identifies one durable workspace
 * with its own files, so the build workspace must never share the project workspace's name, and no
 * request may choose either name.
 */
export const PROJECT_WORKSPACE_NAME = "project-workspace";

export const HARNESS_BUILD_WORKSPACE_NAME = "harness-build-workspace";
