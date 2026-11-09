import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  resolveProject,
  type Project,
  type ProjectCatalog,
  type ProjectId,
} from "../../project-catalog.js";
import {
  PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE,
  type WorkspaceHostNamespace,
} from "../../workspace/index.js";
import type { GitHubConnection } from "../projects/index.js";
import { provisionProjectWorkspace, ProvisionFailed } from "./provisioning.js";

type ProjectUseProblem = Readonly<{
  code:
    | "invalid-project-id"
    | "unknown-project-id"
    | "repository-too-large"
    | "provisioning-failed";
}>;

export type ProjectUseResult =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; problem: ProjectUseProblem }>;

export type ProvisionSources = Readonly<{
  workspaceName: string;
  namespace: WorkspaceHostNamespace<"provision" | "ensureManagedInstructions">;
  github: GitHubConnection;
  catalog: () => ProjectCatalog;
}>;

function failedStepExitCode<A, E>(result: Result.Result<A, E>): number | undefined {
  return Result.isFailure(result) && result.failure instanceof ProvisionFailed
    ? result.failure.exitCode
    : undefined;
}

export function provisionOnUse(
  sources: ProvisionSources,
  projectId: ProjectId,
  signal?: AbortSignal,
): Effect.Effect<ProjectUseResult> {
  const { workspaceName, namespace, github } = sources;

  return Effect.gen(function* () {
    const resolved = resolveProject(projectId, sources.catalog());

    if (!resolved.ok) {
      return { ok: false, problem: { code: resolved.reason } } as const;
    }

    const provision = provisionProjectWorkspace({
      workspaceName,
      project: resolved.project,
      namespace,
      signal,
    });

    let provisioned = yield* Effect.result(provision);

    const credentialWasWorking = github.credentialWorking();

    const firstExitCode = failedStepExitCode(provisioned);

    if (
      !credentialWasWorking &&
      firstExitCode !== undefined &&
      firstExitCode !== PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE
    ) {
      const status = yield* github.ensureCredential(Date.now(), signal);

      if (status.state === "connected" && signal?.aborted !== true) {
        provisioned = yield* Effect.result(provision);
      }
    }

    if (Result.isFailure(provisioned)) {
      return {
        ok: false,
        problem: {
          code:
            failedStepExitCode(provisioned) === PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE
              ? "repository-too-large"
              : "provisioning-failed",
        },
      } as const;
    }

    return { ok: true, project: resolved.project } as const;
  });
}
