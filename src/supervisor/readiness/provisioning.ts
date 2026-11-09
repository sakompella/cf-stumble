import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../../diagnostics.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { Project, ProjectId } from "../../project-catalog.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import type {
  WorkspaceCommandResult,
  WorkspaceFailure,
  WorkspaceHostNamespace,
  WorkspaceHostRpc,
} from "../../workspace/index.js";
import { provisionInWorkspace } from "./provision-fence.js";

export class ProvisionFailed extends Data.TaggedError("ProvisionFailed")<{
  readonly exitCode: number;
}> {}

export class ProvisionUnavailable extends Data.TaggedError("ProvisionUnavailable") {}

type ProvisionProblem = ProvisionFailed | ProvisionUnavailable;

function hostStep<R>(
  context: string,
  call: () => Promise<Readonly<{ ok: true; result: R }> | WorkspaceFailure>,
): Effect.Effect<R, ProvisionUnavailable> {
  return boundedRpc(call, WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.mapError((cause) => {
      logRedactedCause(`${context}: workspace-unavailable`, cause);

      return new ProvisionUnavailable();
    }),
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.result) : Effect.fail(new ProvisionUnavailable()),
    ),
    Effect.uninterruptible,
  );
}

function commandStep(
  context: string,
  call: () => Promise<WorkspaceCommandResult>,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep(context, call).pipe(
    Effect.flatMap((result): Effect.Effect<void, ProvisionProblem> => {
      if (result.kind !== "command") return Effect.fail(new ProvisionUnavailable());

      return result.exitCode === 0
        ? Effect.void
        : Effect.fail(new ProvisionFailed({ exitCode: result.exitCode }));
    }),
  );
}

function instructionsStep(
  context: string,
  host: WorkspaceHostRpc<"ensureManagedInstructions">,
): Effect.Effect<void, ProvisionUnavailable> {
  return Effect.asVoid(hostStep(context, () => host.ensureManagedInstructions()));
}

export function provisionProjectWorkspace(
  input: Readonly<{
    workspaceName: string;
    project: Project;
    namespace: WorkspaceHostNamespace<"provision" | "ensureManagedInstructions">;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { project } = input;

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    projectId: project.id,
    run: Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep(`project-provision.clone (${project.id})`, () =>
        host.provision({
          kind: "provision-project",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
        }),
      );

      yield* instructionsStep(`project-provision.instructions (${project.id})`, host);
    }),
  });
}

export function provisionHarnessWorkspace(
  input: Readonly<{
    workspaceName: string;
    projectId: ProjectId;
    harnessCommit: HarnessCommit;
    namespace: WorkspaceHostNamespace<"build" | "ensureManagedInstructions">;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { harnessCommit } = input;

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    projectId: input.projectId,
    run: Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep("harness-provision.provision", () =>
        host.build({ kind: "build-step", harnessCommit, step: "provision" }),
      );

      yield* instructionsStep("harness-provision.instructions", host);
    }),
  });
}
