import * as Effect from "effect/Effect";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { parseProjectId, type ProjectId } from "../project-catalog.js";
import { HARNESS_PROJECT_ID } from "../selectable-projects.js";
import { shellQuote } from "../shell-quote.js";
import { projectDirectory } from "../workspace-layout.js";
import { holdProvisionLock, projectProvisionLockPath } from "../project-provision.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceCommandResult } from "./decisions.js";
import type { WorkspaceEffects, WorkspaceFault } from "./operations.js";

export type ProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: string;
}>;

type ParsedProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: ProjectId;
}>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

export function parseProjectRemovalRequest(
  request: ProjectRemovalRequest,
): ParsedProjectRemovalRequest | WorkspaceFailure {
  const projectId = parseProjectId(request.projectId);

  return projectId === undefined || projectId === HARNESS_PROJECT_ID
    ? invalidRequest()
    : { kind: "remove-project", projectId };
}

function removedDirectories(projectId: ProjectId): readonly [string, string] {
  const root = projectDirectory(projectId);

  return [root, `${root}.provisioning`];
}

export function planProjectRemovalRequest(
  request: ParsedProjectRemovalRequest,
): Extract<WorkspacePlan, { kind: "run-command" }> {
  const removed = removedDirectories(request.projectId).map((path) => shellQuote(path));

  return {
    kind: "run-command",
    source: [
      "set -eu",
      `lock=${shellQuote(projectProvisionLockPath(request.projectId))}`,
      ...holdProvisionLock(),
      `rm -rf -- ${removed.join(" ")}`,
    ].join("\n"),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}

export function removalIsDurable(
  operations: WorkspaceEffects,
  projectId: ProjectId,
): Effect.Effect<boolean, WorkspaceFault> {
  return Effect.gen(function* () {
    for (const directory of removedDirectories(projectId)) {
      if ((yield* operations.lstat(directory)) !== undefined) return false;
    }

    return true;
  });
}

export type ProjectRemovalWorkspaceHost = Readonly<{
  removeProject(request: ProjectRemovalRequest): Promise<WorkspaceCommandResult>;
}>;

export type ProjectRemovalWorkspaceNamespace = Readonly<{
  getByName(name: string): ProjectRemovalWorkspaceHost;
}>;
