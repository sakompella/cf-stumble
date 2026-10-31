import * as Effect from "effect/Effect";
import type { Generations } from "./generations.js";
import type {
  ProjectCapabilityStub,
  ProjectConnections,
  ProjectWorkspaceNamespace,
} from "./projects/index.js";
import type { SelectableProject } from "../selectable-projects.js";
import {
  provisionHarnessWorkspace,
  waitForWorkspaceProvision,
  type HarnessProvisionWorkspaceNamespace,
} from "../workspace/index.js";

export type WorkspaceSources = Readonly<{
  workspaceName: string;
  namespace: ProjectWorkspaceNamespace & HarnessProvisionWorkspaceNamespace;
  generations: Generations;
  connections: ProjectConnections;
}>;

export function obtainProjectWorkspace(
  sources: WorkspaceSources,
  project: SelectableProject,
  remainingMs: number,
  signal: AbortSignal,
): Effect.Effect<ProjectCapabilityStub | null> {
  const { workspaceName, namespace, generations, connections } = sources;

  return Effect.gen(function* () {
    if (!(yield* waitForWorkspaceProvision(workspaceName, signal))) return null;
    const { generation } = generations.active();

    if (
      project.kind === "harness" &&
      generation !== undefined &&
      !(yield* provisionHarnessWorkspace({
        workspaceName,
        harnessCommit: generation.harnessCommit,
        namespace,
        signal,
      }).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      ))
    ) {
      return null;
    }

    if (
      project.kind === "repository" &&
      !(yield* connections.ensureProvisioned(project.id, signal)).ok
    ) {
      return null;
    }

    return yield* Effect.promise(() =>
      namespace
        .getByName(workspaceName)
        .project({ remainingMs })
        .then(
          (capability) => capability,
          () => null,
        ),
    );
  });
}
