import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import type { HarnessBuildRequest } from "../harness-build.js";
import type { HarnessCommit } from "../harness-commit.js";
import type { Project } from "../project-catalog.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../workspace-command-timeout.js";
import type { WorkspaceResult } from "./decisions.js";
import type { ProjectProvisionRequest } from "./project-provision.js";
import { provisionInWorkspace } from "./provision-exclusion.js";

export class ProvisionFailed extends Data.TaggedError("ProvisionFailed")<{
  readonly exitCode: number;
}> {}

export class ProvisionUnavailable extends Data.TaggedError("ProvisionUnavailable") {}

type ProvisionProblem = ProvisionFailed | ProvisionUnavailable;

type ManagedInstructionsWorkspaceHost = Readonly<{
  ensureManagedInstructions(): Promise<WorkspaceResult>;
}>;

export type ProvisionWorkspaceHost = ManagedInstructionsWorkspaceHost &
  Readonly<{
    provision(request: ProjectProvisionRequest): Promise<WorkspaceResult>;
  }>;

export type HarnessProvisionWorkspaceHost = ManagedInstructionsWorkspaceHost &
  Readonly<{
    build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
  }>;

export type ProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): ProvisionWorkspaceHost;
}>;

export type HarnessProvisionWorkspaceNamespace = Readonly<{
  getByName(name: string): HarnessProvisionWorkspaceHost;
}>;

type HostSuccess = Extract<WorkspaceResult, { ok: true }>["result"];

function hostStep(
  context: string,
  signal: AbortSignal | undefined,
  call: () => Promise<WorkspaceResult>,
): Effect.Effect<HostSuccess, ProvisionUnavailable> {
  return Effect.gen(function* () {
    if (signal !== undefined && signal.aborted) return yield* new ProvisionUnavailable();

    const result = yield* Effect.tryPromise({
      try: () => boundedRpc(call, WORKSPACE_RPC_TIMEOUT_MS),
      catch: (cause) => {
        logRedactedCause(`${context}: workspace-unavailable`, cause);

        return new ProvisionUnavailable();
      },
    });

    if ((signal !== undefined && signal.aborted) || !result.ok)
      return yield* new ProvisionUnavailable();

    return result.result;
  });
}

function commandStep(
  context: string,
  signal: AbortSignal | undefined,
  call: () => Promise<WorkspaceResult>,
): Effect.Effect<void, ProvisionProblem> {
  return hostStep(context, signal, call).pipe(
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
  host: ManagedInstructionsWorkspaceHost,
  signal: AbortSignal | undefined,
): Effect.Effect<void, ProvisionUnavailable> {
  return hostStep(context, signal, () => host.ensureManagedInstructions()).pipe(
    Effect.flatMap((result): Effect.Effect<void, ProvisionUnavailable> =>
      result.kind === "written" ? Effect.void : Effect.fail(new ProvisionUnavailable()),
    ),
  );
}

export function provisionProjectWorkspace(
  input: Readonly<{
    workspaceName: string;
    project: Project;
    namespace: ProvisionWorkspaceNamespace;
    signal?: AbortSignal | undefined;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { project, signal } = input;

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal,
    aborted: new ProvisionUnavailable(),
    run: Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep(`project-provision.clone (${project.id})`, signal, () =>
        host.provision({
          kind: "provision-project",
          projectId: project.id,
          repositoryUrl: project.repositoryUrl,
        }),
      );

      yield* instructionsStep(`project-provision.instructions (${project.id})`, host, signal);
    }),
  });
}

export function provisionHarnessWorkspace(
  input: Readonly<{
    workspaceName: string;
    harnessCommit: HarnessCommit;
    namespace: HarnessProvisionWorkspaceNamespace;
    signal?: AbortSignal | undefined;
  }>,
): Effect.Effect<void, ProvisionProblem> {
  const { harnessCommit, signal } = input;

  return provisionInWorkspace({
    workspaceName: input.workspaceName,
    signal,
    aborted: new ProvisionUnavailable(),
    run: Effect.gen(function* () {
      const host = input.namespace.getByName(input.workspaceName);

      yield* commandStep("harness-provision.provision", signal, () =>
        host.build({ kind: "build-step", harnessCommit, step: "provision" }),
      );

      yield* instructionsStep("harness-provision.instructions", host, signal);
    }),
  });
}
