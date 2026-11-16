import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Generations } from "../generations.js";
import type { GitHubConnection } from "../projects/index.js";
import type { ProjectId } from "../../project-catalog.js";
import type { SelectableProject } from "../../selectable-projects.js";
import type { ProjectCapabilityStub, WorkspaceHostNamespace } from "../../workspace/index.js";
import type { ProvisionFence } from "./provision-fence.js";
import type { ProjectUseResult } from "./provision-on-use.js";
import {
  harnessProblem,
  hostRejected,
  logWorkspaceUnavailable,
  provisionHarnessWorkspace,
  WorkspaceUnavailable,
} from "./provisioning.js";

type ReadinessNamespace = WorkspaceHostNamespace<"project" | "build" | "ensureManagedInstructions">;

type EnsureProvisioned = (projectId: ProjectId) => Effect.Effect<ProjectUseResult>;

interface WorkspaceReadinessInput {
  readonly workspaceName: string;
  readonly fence: ProvisionFence;
  readonly namespace: ReadinessNamespace;
  readonly generations: Generations;
  readonly github: GitHubConnection;
  readonly ensureProvisioned: EnsureProvisioned;
}

export class WorkspaceReadiness {
  private readonly workspaceName: string;
  private readonly fence: ProvisionFence;
  private readonly namespace: ReadinessNamespace;
  private readonly generations: Generations;
  private readonly github: GitHubConnection;
  private readonly ensureProvisioned: EnsureProvisioned;

  constructor(input: WorkspaceReadinessInput) {
    this.workspaceName = input.workspaceName;
    this.fence = input.fence;
    this.namespace = input.namespace;
    this.generations = input.generations;
    this.github = input.github;
    this.ensureProvisioned = input.ensureProvisioned;
  }

  obtain(
    project: SelectableProject | null,
    remainingMs: number,
  ): Effect.Effect<ProjectCapabilityStub, WorkspaceUnavailable, Scope.Scope> {
    if (project === null) return this.capability(remainingMs);

    return Effect.gen({ self: this }, function* () {
      yield* this.fence.wait(project.id);
      yield* this.github.installConfiguredCredential(Date.now());
      yield* this.provision(project);

      return yield* this.capability(remainingMs);
    }).pipe(
      Effect.tapError((reason) =>
        Effect.sync(() => {
          logWorkspaceUnavailable(reason);
        }),
      ),
    );
  }

  forget(): void {
    this.fence.clear();
    this.github.resetWorkspace();
  }

  private provision(project: SelectableProject): Effect.Effect<void, WorkspaceUnavailable> {
    if (project.kind === "repository") {
      return this.ensureProvisioned(project.id).pipe(
        Effect.flatMap((used) =>
          used.ok ? Effect.void : Effect.fail(new WorkspaceUnavailable(used.problem)),
        ),
      );
    }

    const { generation } = this.generations.active();

    if (generation === undefined) return Effect.void;

    return provisionHarnessWorkspace({
      workspaceName: this.workspaceName,
      fence: this.fence,
      projectId: project.id,
      harnessCommit: generation.harnessCommit,
      namespace: this.namespace,
    }).pipe(Effect.mapError(harnessProblem));
  }

  private capability(
    remainingMs: number,
  ): Effect.Effect<ProjectCapabilityStub, WorkspaceUnavailable, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.tryPromise({
        try: () => this.namespace.getByName(this.workspaceName).project({ remainingMs }),
        catch: hostRejected,
      }),
      endWorkspaceTurn,
    );
  }
}

function endWorkspaceTurn(capability: ProjectCapabilityStub): Effect.Effect<void> {
  return Effect.tryPromise(() => capability.endTurn()).pipe(
    Effect.ignore,
    Effect.ensuring(
      Effect.sync(() => {
        capability[Symbol.dispose]();
      }),
    ),
  );
}
