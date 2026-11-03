import * as Schema from "effect/Schema";

const ProviderExit = Schema.Struct({ exitedAt: Schema.Number, reason: Schema.String });

export type ProviderExit = typeof ProviderExit.Type;

const ProviderContainerState = Schema.Union([
  Schema.TaggedStruct("stopped", { exit: Schema.NullOr(ProviderExit) }),
  Schema.TaggedStruct("running", { runtime: Schema.String }),
]);

export type ProviderContainerState = typeof ProviderContainerState.Type;

const ProviderAttachment = Schema.Struct({
  egressPort: Schema.NullOr(Schema.Number),
  container: ProviderContainerState,
});

export type ProviderAttachment = typeof ProviderAttachment.Type;

export type ProviderContainerEvent =
  | Readonly<{ _tag: "started"; runtime: string }>
  | Readonly<{ _tag: "stopped" }>
  | Readonly<{ _tag: "exited"; runtime: string; exit: ProviderExit }>
  | Readonly<{ _tag: "disconnected"; exit: ProviderExit }>;

const NEVER_STARTED: ProviderContainerState = { _tag: "stopped", exit: null };

export const NEW_PROVIDER: ProviderAttachment = { egressPort: null, container: NEVER_STARTED };

export const decodeProviderAttachment = Schema.decodeUnknownOption(ProviderAttachment);

function stoppedIfRunning(
  state: ProviderContainerState,
  exit: ProviderExit,
  runtime?: string,
): ProviderContainerState {
  if (state._tag !== "running") return state;

  if (runtime !== undefined && runtime !== state.runtime) return state;

  return { _tag: "stopped", exit };
}

export function nextProviderState(
  state: ProviderContainerState,
  event: ProviderContainerEvent,
): ProviderContainerState {
  if (event._tag === "started") return { _tag: "running", runtime: event.runtime };

  if (event._tag === "stopped") return NEVER_STARTED;

  if (event._tag === "exited") return stoppedIfRunning(state, event.exit, event.runtime);

  return stoppedIfRunning(state, event.exit);
}
