import type {
  ActivationProblem,
  Generation,
  GenerationLabel,
  GenerationStatus,
  PreparationCheckOutcome,
  PreparationCheckProblem,
} from "./generation.js";

/**
 * Plain snapshot of generation_state so the deciders are pure. Their current + 1 epoch is safe only
 * because the shell runs them in one single-threaded Durable Object transaction.
 */
export type GenerationState = {
  readonly activeLabel: GenerationLabel | undefined;
  readonly epoch: number;
};

type ActivationDecision =
  | { readonly kind: "rejected"; readonly problem: ActivationProblem }
  | { readonly kind: "no-op"; readonly generation: Generation; readonly epoch: number }
  | {
      readonly kind: "activate";
      readonly generation: Generation;
      readonly nextEpoch: number;
    };

export function decideActivation(
  label: GenerationLabel,
  generation: Generation | undefined,
  state: GenerationState,
): ActivationDecision {
  if (generation === undefined) {
    return { kind: "rejected", problem: { code: "unknown-generation", label } };
  }

  if (generation.status !== "ready") {
    return { kind: "rejected", problem: { code: "not-ready", label } };
  }

  if (state.activeLabel === label) {
    return { kind: "no-op", generation, epoch: state.epoch };
  }

  return { kind: "activate", generation, nextEpoch: state.epoch + 1 };
}

type PreparationCheckDecision =
  | { readonly kind: "rejected"; readonly problem: PreparationCheckProblem }
  | {
      readonly kind: "record";
      readonly generation: Generation;
      readonly statusUpdate: GenerationStatus | undefined;
      readonly nextEpoch: number;
      readonly effect: "recorded" | "no-op";
    };

export function decidePreparationCheck(
  label: GenerationLabel,
  outcome: PreparationCheckOutcome,
  generation: Generation | undefined,
  state: GenerationState,
): PreparationCheckDecision {
  if (generation === undefined) {
    return { kind: "rejected", problem: { code: "unknown-generation", label } };
  }

  const status: GenerationStatus = outcome === "passed" ? "ready" : "failed";
  const nextEpoch = state.epoch + 1;

  if (generation.status === status) {
    return {
      kind: "record",
      generation,
      statusUpdate: undefined,
      nextEpoch,
      effect: "no-op",
    };
  }

  return {
    kind: "record",
    generation: { ...generation, status },
    statusUpdate: status,
    nextEpoch,
    effect: "recorded",
  };
}

export function assertNever(value: never): never {
  throw new Error(`unexpected generation decision: ${JSON.stringify(value)}`);
}
