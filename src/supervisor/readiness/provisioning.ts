import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logEvent, redactedExcerpt } from "../../diagnostics.js";
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

type WorkspaceUnavailableCode =
  | "invalid-project-id"
  | "unknown-project-id"
  | "repository-too-large"
  | "clone-failed"
  | "harness-provision-failed"
  | "host-unavailable"
  | "released";

export type WorkspaceUnavailableReason = Readonly<{
  code: WorkspaceUnavailableCode;
  detail: string;
}>;

export class WorkspaceUnavailable extends Data.TaggedError(
  "WorkspaceUnavailable",
)<WorkspaceUnavailableReason> {
  override get message(): string {
    return `workspace unavailable: ${this.code}${this.detail && ` (${this.detail})`}`;
  }
}

export function logWorkspaceUnavailable({ code, detail }: WorkspaceUnavailableReason): void {
  logEvent("warn", "workspace.unavailable", { code, detail });
}

export function hostRejected(cause: unknown): WorkspaceUnavailable {
  return new WorkspaceUnavailable({
    code: "host-unavailable",
    detail: redactedExcerpt(cause instanceof Error ? cause.message : String(cause)),
  });
}

export function harnessProblem(
  failure: ProvisionFailed | ProvisionUnavailable,
): WorkspaceUnavailable {
  return failure instanceof ProvisionFailed
    ? new WorkspaceUnavailable({
        code: "harness-provision-failed",
        detail: `exit ${String(failure.exitCode)}${failure.stderr && `: ${failure.stderr}`}`,
      })
    : new WorkspaceUnavailable({ code: "host-unavailable", detail: failure.detail });
}

export class ProvisionFailed extends Data.TaggedError("ProvisionFailed")<{
  readonly exitCode: number;
  readonly stderr: string;
}> {}

export class ProvisionTooLarge extends Data.TaggedError("ProvisionTooLarge")<{
  readonly verdict: CloneSizeVerdict;
}> {}

export class ProvisionUnavailable extends Data.TaggedError("ProvisionUnavailable")<{
  readonly detail: string;
}> {}

export type ProvisionProblem = ProvisionFailed | ProvisionTooLarge | ProvisionUnavailable;

function hostStep<Answer, Problem extends ProvisionProblem>(
  call: () => Promise<Answer>,
  settle: (answer: Answer) => Effect.Effect<void, Problem>,
): Effect.Effect<void, Problem | ProvisionUnavailable> {
  return boundedRpc(call, WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.mapError(
      (failure) => new ProvisionUnavailable({ detail: redactedExcerpt(failure.message) }),
    ),
    Effect.flatMap(settle),
    Effect.uninterruptible,
  );
}

function commandStep(
  call: () => Promise<CommandAnswer>,
): Effect.Effect<void, ProvisionFailed | ProvisionUnavailable> {
  return hostStep<CommandAnswer, ProvisionFailed | ProvisionUnavailable>(call, (answer) => {
    if (!answer.ok) return Effect.fail(new ProvisionUnavailable({ detail: answer.error.code }));

    return answer.output.exitCode === 0
      ? Effect.void
      : Effect.fail(
          new ProvisionFailed({
            exitCode: answer.output.exitCode,
            stderr: redactedExcerpt(answer.output.stderr.trim()),
          }),
        );
  });
}

function cloneStep(
  call: () => Promise<ProjectProvisionAnswer>,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep<ProjectProvisionAnswer, ProvisionProblem>(call, (answer) => {
    if (answer.ok) return Effect.void;

    const { error } = answer;

    if (error.code === "repository-too-large") {
      return Effect.fail(new ProvisionTooLarge({ verdict: error.verdict }));
    }

    return Effect.fail(
      error.code === "clone-failed"
        ? new ProvisionFailed({ exitCode: error.exitCode, stderr: "" })
        : new ProvisionUnavailable({ detail: error.code }),
    );
  });
}

function instructionsStep(
  host: WorkspaceHostRpc<"ensureManagedInstructions">,
): Effect.Effect<void, ProvisionUnavailable> {
  return hostStep(
    () => host.ensureManagedInstructions(),
    (answer) =>
      answer.ok
        ? Effect.void
        : Effect.fail(new ProvisionUnavailable({ detail: answer.error.code })),
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

      yield* cloneStep(() =>
        host.provision({
          kind: "provision-project",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
        }),
      );

      yield* instructionsStep(host);
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
): Effect.Effect<void, ProvisionFailed | ProvisionUnavailable> {
  const { harnessCommit } = input;

  return input.fence.provision(
    input.projectId,
    Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep(() => host.build({ harnessCommit, step: "provision" }));

      yield* instructionsStep(host);
    }),
  );
}
