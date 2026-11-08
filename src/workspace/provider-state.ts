import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const ProviderExit = Schema.Struct({ exitedAt: Schema.Number, reason: Schema.String });

export type ProviderExit = typeof ProviderExit.Type;

const Stopped = Schema.TaggedStruct("stopped", { exit: Schema.NullOr(ProviderExit) });

const Running = Schema.TaggedStruct("running", { runtime: Schema.String });

const ProviderContainerState = Schema.Union([Stopped, Running]);

export type ProviderContainerState = typeof ProviderContainerState.Type;

const ProviderAttachment = Schema.Struct({
  egressPort: Schema.NullOr(Schema.Number),
  container: ProviderContainerState,
});

export type ProviderAttachment = typeof ProviderAttachment.Type;

const Started = Schema.TaggedStruct("started", { runtime: Schema.String });

const Halted = Schema.TaggedStruct("stopped", {});

const Exited = Schema.TaggedStruct("exited", { runtime: Schema.String, exit: ProviderExit });

const Disconnected = Schema.TaggedStruct("disconnected", { exit: ProviderExit });

const ProviderContainerEvent = Schema.Union([Started, Halted, Exited, Disconnected]);

export type ProviderContainerEvent = typeof ProviderContainerEvent.Type;

export const providerEvent = {
  started: (fields: Omit<typeof Started.Type, "_tag">) => Started.make(fields),
  stopped: () => Halted.make({}),
  exited: (fields: Omit<typeof Exited.Type, "_tag">) => Exited.make(fields),
  disconnected: (fields: Omit<typeof Disconnected.Type, "_tag">) => Disconnected.make(fields),
};

export function stoppedState(exit: ProviderExit | null): ProviderContainerState {
  return Stopped.make({ exit });
}

const NEVER_STARTED = stoppedState(null);

export const NEW_PROVIDER: ProviderAttachment = { egressPort: null, container: NEVER_STARTED };

export const decodeProviderAttachment = Schema.decodeUnknownOption(ProviderAttachment);

function stoppedIfRunning(
  state: ProviderContainerState,
  exit: ProviderExit,
  runtime?: string,
): ProviderContainerState {
  if (!Predicate.isTagged(state, "running")) return state;

  if (runtime !== undefined && runtime !== state.runtime) return state;

  return stoppedState(exit);
}

export function nextProviderState(
  state: ProviderContainerState,
  event: ProviderContainerEvent,
): ProviderContainerState {
  return Match.value(event).pipe(
    Match.tag("started", ({ runtime }) => Running.make({ runtime })),
    Match.tag("stopped", () => NEVER_STARTED),
    Match.tag("exited", ({ exit, runtime }) => stoppedIfRunning(state, exit, runtime)),
    Match.tag("disconnected", ({ exit }) => stoppedIfRunning(state, exit)),
    Match.exhaustive,
  );
}
