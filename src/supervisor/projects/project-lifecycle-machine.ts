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
  Provision: { readonly attempt: "connect" };
  RemoveDirectories: { readonly cause: "disconnect" | "failed-provision" };
}>;

export const LifecycleCommand = Data.taggedEnum<LifecycleCommand>();

export type LifecycleStep = Readonly<{
  state: ProjectState | undefined;
  commands: readonly LifecycleCommand[];
}>;

function stay(state: ProjectState | undefined): LifecycleStep {
  return { state, commands: [] };
}

function removing(cause: "disconnect" | "failed-provision"): LifecycleStep {
  return { state: "removing", commands: [LifecycleCommand.RemoveDirectories({ cause })] };
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
            commands: [LifecycleCommand.Provision({ attempt: "connect" })],
          },
    provisioned: () => (current === "provisioning" ? stay("connected") : stay(current)),
    provisionFailed: () =>
      current === "provisioning" ? removing("failed-provision") : stay(current),
    disconnect: () => (current === undefined ? stay(current) : removing("disconnect")),
    removed: () => (current === "removing" ? { state: undefined, commands: [] } : stay(current)),
    removalFailed: () => stay(current),
  });
}
