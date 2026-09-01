import type {
  ActivationProblem,
  Generation,
  GenerationLabel,
  GenerationStatus,
  PreparationCheckOutcome,
  PreparationCheckProblem,
} from "./generation.js";

/**
 * A plain-value snapshot of the generation_state singleton. The deciders below take one of these
 * instead of reading SQLite, so the activation and preparation-check rules are pure: they can be
 * unit-tested with literals, no Durable Object and no storage. The imperative shell in index.ts
 * reads this, calls a decider, and applies the effects the decision names.
 *
 * The deciders compute the next epoch and activation id as absolute values (current + 1). That is
 * safe only because the shell runs them inside a single Durable Object transaction, which is
 * single-threaded, so nothing interleaves between the read and the write. In a concurrent store
 * this would be a lost update and the counters would have to be incremented atomically in SQL.
 */
export type GenerationState = {
  readonly activeLabel: GenerationLabel | undefined;
  readonly epoch: number;
  readonly activationId: number;
};

export type ActivationDecision =
  | { readonly kind: "rejected"; readonly problem: ActivationProblem }
  | { readonly kind: "no-op"; readonly generation: Generation; readonly epoch: number }
  | {
      readonly kind: "activate";
      readonly generation: Generation;
      readonly nextEpoch: number;
      readonly nextActivationId: number;
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
  return {
    kind: "activate",
    generation,
    nextEpoch: state.epoch + 1,
    nextActivationId: state.activationId + 1,
  };
}

export type PreparationCheckDecision =
  | { readonly kind: "rejected"; readonly problem: PreparationCheckProblem }
  | {
      readonly kind: "record";
      readonly outcome: PreparationCheckOutcome;
      readonly generation: Generation;
      // A resulting status to write, or undefined when the recorded outcome only confirms the
      // current one and the effect is a no-op.
      readonly statusUpdate: GenerationStatus | undefined;
      readonly nextEpoch: number;
      readonly effect: "recorded" | "no-op";
    };

export function decidePreparationCheck(
  label: GenerationLabel,
  // Untrusted input: callers forward an outcome that has not been validated, so parse it here and
  // let control-flow analysis narrow it to PreparationCheckOutcome past this guard.
  outcome: string,
  generation: Generation | undefined,
  state: GenerationState,
): PreparationCheckDecision {
  if (outcome !== "passed" && outcome !== "failed") {
    return { kind: "rejected", problem: { code: "invalid-preparation-check-outcome" } };
  }
  if (generation === undefined) {
    return { kind: "rejected", problem: { code: "unknown-generation", label } };
  }

  const status: GenerationStatus = outcome === "passed" ? "ready" : "failed";
  const nextEpoch = state.epoch + 1;

  if (generation.status !== "candidate") {
    if (generation.status !== status) {
      return {
        kind: "rejected",
        problem: { code: "contradicts-recorded-outcome", label, recorded: generation.status },
      };
    }
    return {
      kind: "record",
      outcome,
      generation,
      statusUpdate: undefined,
      nextEpoch,
      effect: "no-op",
    };
  }

  return {
    kind: "record",
    outcome,
    generation: { ...generation, status },
    statusUpdate: status,
    nextEpoch,
    effect: "recorded",
  };
}

export function assertNever(value: never): never {
  throw new Error(`unexpected generation decision: ${JSON.stringify(value)}`);
}
