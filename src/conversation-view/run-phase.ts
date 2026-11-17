import * as Schema from "effect/Schema";

export const RunPhase = Schema.Literals([
  "Idle",
  "Preparing",
  "Compacting",
  "WaitingForModel",
  "Working",
]);

export type RunPhase = typeof RunPhase.Type;

type LiveRunState = Readonly<{
  run?: Readonly<{ afterRun?: unknown }>;
  generation?: Readonly<{ message?: unknown }>;
  tools?: readonly unknown[];
  compactions?: readonly unknown[];
}>;

export function runPhaseOf(live: LiveRunState | undefined): RunPhase {
  if (live?.run === undefined) return "Idle";

  if ((live.compactions ?? []).length > 0) return "Compacting";

  if (live.generation !== undefined) {
    return live.generation.message === undefined ? "WaitingForModel" : "Working";
  }

  return (live.tools ?? []).length === 0 && live.run.afterRun === undefined
    ? "Preparing"
    : "Working";
}

const WORDING: Readonly<Record<RunPhase, string>> = {
  Idle: "",
  Preparing: "preparing the workspace",
  Compacting: "summarizing earlier messages",
  WaitingForModel: "waiting for the model",
  Working: "",
};

export function phaseWording(phase: RunPhase): string {
  return WORDING[phase];
}
