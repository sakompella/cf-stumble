import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export const ProjectState = Schema.Literals(["provisioning", "connected", "removing"]);

export type ProjectState = typeof ProjectState.Type;

export const LifecycleEvent = Schema.TaggedUnion({
  connect: {},
  provisioned: {},
  provisionFailed: {},
  disconnect: {},
  removed: {},
  removalFailed: {},
});

export type LifecycleEvent = typeof LifecycleEvent.Type;

export type LifecycleCommand = Data.TaggedEnum<{
  Provision: object;
  RemoveDirectories: object;
}>;

export const LifecycleCommand = Data.taggedEnum<LifecycleCommand>();

export type LifecycleStep = Readonly<{
  state: ProjectState | undefined;
  commands: readonly LifecycleCommand[];
}>;

function stay(state: ProjectState | undefined): LifecycleStep {
  return { state, commands: [] };
}

function removing(): LifecycleStep {
  return { state: "removing", commands: [LifecycleCommand.RemoveDirectories()] };
}

export function lifecycleStep(
  current: ProjectState | undefined,
  event: LifecycleEvent,
): LifecycleStep {
  return LifecycleEvent.match(event, {
    connect: () =>
      current === "connected" || current === "removing"
        ? stay(current)
        : {
            state: "provisioning" as const,
            commands: [LifecycleCommand.Provision()],
          },
    provisioned: () => (current === "provisioning" ? stay("connected") : stay(current)),
    provisionFailed: () => (current === "provisioning" ? removing() : stay(current)),
    disconnect: () => (current === undefined ? stay(current) : removing()),
    removed: () => (current === "removing" ? { state: undefined, commands: [] } : stay(current)),
    removalFailed: () => stay(current),
  });
}
