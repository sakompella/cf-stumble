import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../../diagnostics.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { Project, ProjectId } from "../../project-catalog.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import type {
  CloneSizeVerdict,
  CommandAnswer,
  ProjectProvisionAnswer,
  WorkspaceHostNamespace,
  WorkspaceHostRpc,
} from "../../workspace/index.js";
import type { ProvisionFence } from "./provision-fence.js";

export class ProvisionFailed extends Data.TaggedError("ProvisionFailed")<{
  readonly exitCode: number;
}> {}

export class ProvisionTooLarge extends Data.TaggedError("ProvisionTooLarge")<{
  readonly verdict: CloneSizeVerdict;
}> {}

export class ProvisionUnavailable extends Data.TaggedError("ProvisionUnavailable") {}

export type ProvisionProblem = ProvisionFailed | ProvisionTooLarge | ProvisionUnavailable;

function hostStep<Answer>(
  context: string,
  call: () => Promise<Answer>,
  settle: (answer: Answer) => Effect.Effect<void, ProvisionProblem>,
): Effect.Effect<void, ProvisionProblem> {
  return boundedRpc(call, WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.mapError((cause): ProvisionProblem => {
      logRedactedCause(`${context}: workspace-unavailable`, cause);

      return new ProvisionUnavailable();
    }),
    Effect.flatMap(settle),
    Effect.uninterruptible,
  );
}

function commandStep(
  context: string,
  call: () => Promise<CommandAnswer>,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep(context, call, (answer) => {
    if (!answer.ok) return Effect.fail(new ProvisionUnavailable());

    return answer.output.exitCode === 0
      ? Effect.void
      : Effect.fail(new ProvisionFailed({ exitCode: answer.output.exitCode }));
  });
}

function cloneStep(
  context: string,
  call: () => Promise<ProjectProvisionAnswer>,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep(context, call, (answer) => {
    if (answer.ok) return Effect.void;

    const { error } = answer;

    if (error.code === "repository-too-large") {
      return Effect.fail(new ProvisionTooLarge({ verdict: error.verdict }));
    }

    return error.code === "clone-failed"
      ? Effect.fail(new ProvisionFailed({ exitCode: error.exitCode }))
      : Effect.fail(new ProvisionUnavailable());
  });
}

function instructionsStep(
  context: string,
  host: WorkspaceHostRpc<"ensureManagedInstructions">,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep(
    context,
    () => host.ensureManagedInstructions(),
    (answer) => (answer.ok ? Effect.void : Effect.fail(new ProvisionUnavailable())),
  );
}

export function provisionProjectWorkspace(
  input: Readonly<{
    workspaceName: string;
    fence: ProvisionFence;
    project: Project;
    namespace: WorkspaceHostNamespace<"provision" | "ensureManagedInstructions">;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { project } = input;

  return input.fence.provision(
    project.id,
    Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* cloneStep(`project-provision.clone (${project.id})`, () =>
        host.provision({
          kind: "provision-project",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
        }),
      );

      yield* instructionsStep(`project-provision.instructions (${project.id})`, host);
    }),
  );
}

export function provisionHarnessWorkspace(
  input: Readonly<{
    workspaceName: string;
    fence: ProvisionFence;
    projectId: ProjectId;
    harnessCommit: HarnessCommit;
    namespace: WorkspaceHostNamespace<"build" | "ensureManagedInstructions">;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { harnessCommit } = input;

  return input.fence.provision(
    input.projectId,
    Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep("harness-provision.provision", () =>
        host.build({ harnessCommit, step: "provision" }),
      );

      yield* instructionsStep("harness-provision.instructions", host);
    }),
  );
}
