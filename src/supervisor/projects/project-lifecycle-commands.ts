import * as Effect from "effect/Effect";
import type { ProjectId } from "../../project-catalog.js";
import type { ProjectUseResult } from "../readiness/provision-on-use.js";
import type { ConnectedProjects } from "./connected-projects.js";
import { LifecycleCommand, LifecycleEvent } from "./project-lifecycle-machine.js";

export type Execution = Readonly<{
  provision?: ProjectUseResult;
  removal?: "removed" | "failed";
}>;

export interface LifecycleEffects {
  readonly projects: ConnectedProjects;
  readonly provision: (projectId: ProjectId) => Effect.Effect<ProjectUseResult>;
  readonly remove: (projectId: ProjectId) => Effect.Effect<"removed" | "failed">;
}

export function execute(
  effects: LifecycleEffects,
  projectId: ProjectId,
  commands: readonly LifecycleCommand[],
): Effect.Effect<Execution> {
  return Effect.gen(function* () {
    let execution: Execution = {};

    for (const command of commands) {
      const performed = yield* perform(effects, projectId, command);
      const followed = yield* execute(effects, projectId, performed.follow);

      execution = { ...execution, ...performed.report, ...followed };
    }

    return execution;
  });
}

function perform(
  effects: LifecycleEffects,
  projectId: ProjectId,
  command: LifecycleCommand,
): Effect.Effect<Readonly<{ report: Execution; follow: readonly LifecycleCommand[] }>> {
  return LifecycleCommand.$match(command, {
    Provision: () =>
      effects.provision(projectId).pipe(
        Effect.map((provision) => ({
          report: { provision },
          follow:
            effects.projects.apply(
              projectId,
              provision.ok
                ? LifecycleEvent.cases.provisioned.make({})
                : LifecycleEvent.cases.provisionFailed.make({}),
            )?.commands ?? [],
        })),
      ),
    RemoveDirectories: () =>
      effects.remove(projectId).pipe(
        Effect.map((removal) => ({
          report: { removal },
          follow:
            effects.projects.apply(
              projectId,
              removal === "removed"
                ? LifecycleEvent.cases.removed.make({})
                : LifecycleEvent.cases.removalFailed.make({}),
            )?.commands ?? [],
        })),
      ),
  });
}

export function disconnect(
  effects: LifecycleEffects,
  projectId: ProjectId,
): Effect.Effect<Execution> {
  return Effect.suspend(() =>
    execute(
      effects,
      projectId,
      effects.projects.apply(projectId, LifecycleEvent.cases.disconnect.make({}))?.commands ?? [],
    ),
  );
}

export function recover(effects: LifecycleEffects, projectId: ProjectId): Effect.Effect<Execution> {
  return Effect.suspend(() => {
    const state = effects.projects.stateOf(projectId);

    if (state === "provisioning") {
      return execute(
        effects,
        projectId,
        effects.projects.apply(projectId, LifecycleEvent.cases.provisionFailed.make({}))
          ?.commands ?? [],
      );
    }

    return state === "removing" ? disconnect(effects, projectId) : Effect.succeed({});
  });
}
