import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { parseProjectId, type ProjectId } from "../project-catalog.js";
import { HARNESS_PROJECT_ID } from "../selectable-projects.js";
import { shellQuote } from "../shell-quote.js";
import { projectDirectory } from "../workspace-layout.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceResult } from "./decisions.js";
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

/** Remove only the project clone and the fixed provisioning remnants. */
export function planProjectRemovalRequest(
  request: ParsedProjectRemovalRequest,
): Extract<WorkspacePlan, { kind: "run-command" }> {
  const root = projectDirectory(request.projectId);

  return {
    kind: "run-command",
    source: [
      "set -eu",
      `rm -rf -- ${[root, `${root}.provisioning`, `${root}.provision-lock`].map((path) => shellQuote(path)).join(" ")}`,
    ].join("\n"),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}

export type ProjectRemovalWorkspaceHost = Readonly<{
  removeProject(request: ProjectRemovalRequest): Promise<WorkspaceResult>;
}>;
