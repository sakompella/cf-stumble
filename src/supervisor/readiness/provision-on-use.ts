import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  resolveProject,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../../project-catalog.js";
import type { WorkspaceHostNamespace } from "../../workspace/index.js";
import type { GitHubConnection } from "../projects/index.js";
import type { ProvisionFence } from "./provision-fence.js";
import {
  provisionProjectWorkspace,
  ProvisionFailed,
  ProvisionTooLarge,
  type ProvisionProblem,
  type WorkspaceUnavailableReason,
} from "./provisioning.js";

export type ProjectUseResult =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; problem: WorkspaceUnavailableReason }>;

export type ProvisionSources = Readonly<{
  workspaceName: string;
  fence: ProvisionFence;
  namespace: WorkspaceHostNamespace<"provision" | "ensureManagedInstructions">;
  github: GitHubConnection;
  catalog: () => ProjectCatalog;
}>;

function useProblem(failure: ProvisionProblem): WorkspaceUnavailableReason {
  if (failure instanceof ProvisionTooLarge) {
    return { code: "repository-too-large", detail: failure.verdict };
  }

  return failure instanceof ProvisionFailed
    ? { code: "clone-failed", detail: `exit ${String(failure.exitCode)}` }
    : { code: "host-unavailable", detail: failure.detail };
}

export function provisionOnUse(
  sources: ProvisionSources,
  projectId: ProjectId,
): Effect.Effect<ProjectUseResult> {
  const { workspaceName, fence, namespace, github } = sources;

  return Effect.gen(function* () {
    const resolved = resolveProject(projectId, sources.catalog());

    if (!resolved.ok) {
      return { ok: false, problem: { code: resolved.reason, detail: "" } } as const;
    }

    const provision = provisionProjectWorkspace({
      workspaceName,
      fence,
      project: resolved.project,
      namespace,
    });

    let provisioned = yield* Effect.result(provision);

    const credentialWasWorking = github.credentialWorking();

    if (
      !credentialWasWorking &&
      Result.isFailure(provisioned) &&
      provisioned.failure instanceof ProvisionFailed
    ) {
      const status = yield* Effect.result(github.ensureCredential(Date.now()));

      if (Result.isSuccess(status) && status.success.state === "connected") {
        provisioned = yield* Effect.result(provision);
      }
    }

    if (Result.isFailure(provisioned)) {
      return { ok: false, problem: useProblem(provisioned.failure) } as const;
    }

    return { ok: true, project: resolved.project } as const;
  });
}
