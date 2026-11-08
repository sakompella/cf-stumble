import * as Effect from "effect/Effect";
import type { Generations } from "../generations.js";
import type { GitHubConnection } from "../projects/index.js";
import type { ProjectId } from "../../project-catalog.js";
import type { SelectableProject } from "../../selectable-projects.js";
import type { ProjectCapabilityStub, WorkspaceHostNamespace } from "../../workspace/index.js";
import { clearWorkspaceProvision, waitForWorkspaceProvision } from "./provision-fence.js";
import type { ProjectUseResult } from "./provision-on-use.js";
import { provisionHarnessWorkspace } from "./provisioning.js";

type ReadinessNamespace = WorkspaceHostNamespace<"project" | "build" | "ensureManagedInstructions">;

type EnsureProvisioned = (
  projectId: ProjectId,
  signal: AbortSignal,
) => Effect.Effect<ProjectUseResult>;

interface WorkspaceReadinessInput {
  readonly workspaceName: string;
  readonly namespace: ReadinessNamespace;
  readonly generations: Generations;
  readonly github: GitHubConnection;
  readonly ensureProvisioned: EnsureProvisioned;
}

export class WorkspaceReadiness {
  private readonly workspaceName: string;
  private readonly namespace: ReadinessNamespace;
  private readonly generations: Generations;
  private readonly github: GitHubConnection;
  private readonly ensureProvisioned: EnsureProvisioned;

  constructor(input: WorkspaceReadinessInput) {
    this.workspaceName = input.workspaceName;
    this.namespace = input.namespace;
    this.generations = input.generations;
    this.github = input.github;
    this.ensureProvisioned = input.ensureProvisioned;
  }

  obtain(
    project: SelectableProject | null,
    remainingMs: number,
    signal: AbortSignal,
  ): Effect.Effect<ProjectCapabilityStub | null> {
    if (project === null) {
      return signal.aborted ? Effect.succeed(null) : this.capability(remainingMs);
    }

    return Effect.gen({ self: this }, function* () {
      if (!(yield* waitForWorkspaceProvision(this.workspaceName, project.id, signal))) return null;

      if (!(yield* this.provision(project, signal))) return null;

      return yield* this.capability(remainingMs);
    });
  }

  forget(): void {
    clearWorkspaceProvision(this.workspaceName);
    this.github.resetWorkspace();
  }

  private provision(project: SelectableProject, signal: AbortSignal): Effect.Effect<boolean> {
    if (project.kind === "repository") {
      return this.ensureProvisioned(project.id, signal).pipe(Effect.map((used) => used.ok));
    }

    const { generation } = this.generations.active();

    if (generation === undefined) return Effect.succeed(true);

    return provisionHarnessWorkspace({
      workspaceName: this.workspaceName,
      projectId: project.id,
      harnessCommit: generation.harnessCommit,
      namespace: this.namespace,
      signal,
    }).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );
  }

  private capability(remainingMs: number): Effect.Effect<ProjectCapabilityStub | null> {
    return Effect.promise(() =>
      this.namespace
        .getByName(this.workspaceName)
        .project({ remainingMs })
        .then(
          (capability) => capability,
          () => null,
        ),
    );
  }
}
