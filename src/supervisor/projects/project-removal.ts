import * as Effect from "effect/Effect";
import { logRedactedCause } from "../../diagnostics.js";
import type { ProjectId } from "../../project-catalog.js";
import type { ProjectRemovalWorkspaceNamespace } from "../../workspace/index.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";

export function removeProjectDirectories(
  namespace: ProjectRemovalWorkspaceNamespace,
  workspaceName: string,
  projectId: ProjectId,
): Effect.Effect<"removed" | "failed"> {
  return boundedRpc(
    () => namespace.getByName(workspaceName).removeProject({ kind: "remove-project", projectId }),
    WORKSPACE_RPC_TIMEOUT_MS,
  ).pipe(
    Effect.match({
      onSuccess: (result) =>
        result.ok && result.result.kind === "command" && result.result.exitCode === 0
          ? "removed"
          : "failed",
      onFailure: (cause) => {
        logRedactedCause(`project-disconnect.${projectId}: workspace-unavailable`, cause);

        return "failed";
      },
    }),
  );
}
