import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { parseProjectId, type ProjectId } from "../project-catalog.js";
import { HARNESS_PROJECT_ID } from "../selectable-projects.js";
import { shellQuote } from "../shell-quote.js";
import { projectDirectory } from "../workspace-layout.js";
import { holdProvisionLock, projectProvisionLockPath } from "../project-provision.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceResult } from "./decisions.js";
import type { WorkspaceOperations } from "./executor.js";
import { asUntrusted, field, fieldsAreExactly, type UntrustedObject } from "./untrusted.js";

/** The only workspace removal request. Its paths are derived from the parsed id. */
export type ProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: string;
}>;

export type ParsedProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: ProjectId;
}>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

function parsedProjectId(value: UntrustedObject): ProjectId | undefined {
  const projectId = parseProjectId(field(value, "projectId"));

  return projectId === undefined || projectId === HARNESS_PROJECT_ID ? undefined : projectId;
}

/** Parse the narrow host RPC before deriving any filesystem path. */
export function parseProjectRemovalRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Workspace Host RPC boundary.
  value: unknown,
): ParsedProjectRemovalRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);

  if (
    field(request, "kind") !== "remove-project" ||
    !fieldsAreExactly(request, ["kind", "projectId"])
  ) {
    return invalidRequest();
  }

  const projectId = parsedProjectId(request);

  return projectId === undefined ? invalidRequest() : { kind: "remove-project", projectId };
}

/** The directories a removal deletes and then expects to be gone from the durable store. */
function removedDirectories(projectId: ProjectId): readonly [string, string] {
  const root = projectDirectory(projectId);

  return [root, `${root}.provisioning`];
}

/**
 * Remove only the project clone and its staging directory, while holding the project's provision
 * lock. The Supervisor orders its own requests, but a removal can outlive the RPC that asked for
 * it, and the lock is what keeps a later clone out of the directory it is deleting. The
 * `.provision-lock` directory is what earlier versions locked with; nothing uses it now, so it is
 * removed as a remnant.
 */
export function planProjectRemovalRequest(
  request: ParsedProjectRemovalRequest,
): Extract<WorkspacePlan, { kind: "run-command" }> {
  const [root, staging] = removedDirectories(request.projectId);

  return {
    kind: "run-command",
    source: [
      "set -eu",
      `lock=${shellQuote(projectProvisionLockPath(request.projectId))}`,
      ...holdProvisionLock(),
      `rm -rf -- ${[root, staging, `${root}.provision-lock`].map((path) => shellQuote(path)).join(" ")}`,
    ].join("\n"),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Whether a removal that exited successfully is in the durable workspace store: neither the clone
 * nor its staging directory is there. The store is what the next container starts from, so a
 * directory still present there would come back.
 */
export async function removalIsDurable(
  operations: WorkspaceOperations,
  projectId: ProjectId,
): Promise<boolean> {
  for (const directory of removedDirectories(projectId)) {
    if ((await operations.lstat(directory)) !== undefined) return false;
  }

  return true;
}

export type ProjectRemovalWorkspaceHost = Readonly<{
  removeProject(request: ProjectRemovalRequest): Promise<WorkspaceResult>;
}>;
