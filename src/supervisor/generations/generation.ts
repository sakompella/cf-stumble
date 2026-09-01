import type { Result } from "better-result";
import type { HarnessCommit } from "../../harness-commit.js";

export type GenerationStatus = "candidate" | "ready" | "failed";

declare const generationLabelBrand: unique symbol;

export type GenerationLabel = number & {
  readonly [generationLabelBrand]: "GenerationLabel";
};

export function parseGenerationLabel(value: number): GenerationLabel | undefined {
  if (!Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the guard accepts only non-negative safe integer GenerationLabel values.
  return value as GenerationLabel;
}

export type Generation = {
  readonly label: GenerationLabel;
  readonly harnessCommit: HarnessCommit;
  readonly status: GenerationStatus;
};

export type ActiveGeneration = {
  readonly generation: Generation | undefined;
  readonly epoch: number;
  readonly activationId: number | undefined;
};

export type PreparationCheckOutcome = "passed" | "failed";

export type PreparationCheckProblem =
  | { readonly code: "unknown-generation"; readonly label: number }
  | { readonly code: "invalid-preparation-check-outcome" }
  | {
      readonly code: "contradicts-recorded-outcome";
      readonly label: number;
      readonly recorded: GenerationStatus;
    };

export type PreparationCheckResult = Result<
  {
    readonly generation: Generation;
    readonly epoch: number;
    readonly effect: "recorded" | "no-op";
  },
  PreparationCheckProblem
>;

export type ActivationProblem =
  | { readonly code: "unknown-generation"; readonly label: number }
  | { readonly code: "not-ready"; readonly label: number };

export type ActivationResult = Result<
  {
    readonly generation: Generation;
    readonly epoch: number;
    readonly effect: "activated" | "no-op";
  },
  ActivationProblem
>;
