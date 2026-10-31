import * as Effect from "effect/Effect";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { parseProjectId, type ProjectId } from "../project-catalog.js";
import { HARNESS_PROJECT_ID } from "../selectable-projects.js";
import { shellQuote } from "../shell-quote.js";
import { projectDirectory } from "../workspace-layout.js";
import { holdProvisionLock, projectProvisionLockPath } from "../project-provision.js";
import type { WorkspaceFailure, WorkspacePlan, WorkspaceResult } from "./decisions.js";
import type { WorkspaceEffects, WorkspaceFault } from "./operations.js";
import { asUntrusted, field, hasExactKeys, type UntrustedObject } from "../untrusted.js";

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

function parsedProjectId(value: UntrustedObject): ProjectId | undefined {
  const projectId = parseProjectId(field(value, "projectId"));

  return projectId === undefined || projectId === HARNESS_PROJECT_ID ? undefined : projectId;
}

export function parseProjectRemovalRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Workspace Host RPC boundary.
  value: unknown,
): ParsedProjectRemovalRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);

  if (
    field(request, "kind") !== "remove-project" ||
    !hasExactKeys(request, ["kind", "projectId"])
  ) {
    return invalidRequest();
  }

  const projectId = parsedProjectId(request);

  return projectId === undefined ? invalidRequest() : { kind: "remove-project", projectId };
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
  removeProject(request: ProjectRemovalRequest): Promise<WorkspaceResult>;
}>;
