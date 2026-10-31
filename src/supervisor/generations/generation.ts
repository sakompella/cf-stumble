import type * as Result from "effect/Result";
import type { HarnessCommit } from "../../harness-commit.js";

export type GenerationStatus = "candidate" | "ready" | "failed";

declare const generationLabelBrand: unique symbol;

export type GenerationLabel = number & {
  readonly [generationLabelBrand]: "GenerationLabel";
};

function isGenerationLabel(value: number): value is GenerationLabel {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parseGenerationLabel(value: number): GenerationLabel | undefined {
  return isGenerationLabel(value) ? value : undefined;
}

export type Generation = {
  readonly label: GenerationLabel;
  readonly harnessCommit: HarnessCommit;
  readonly status: GenerationStatus;
};

export type ActiveGeneration = {
  readonly generation: Generation | undefined;
  readonly epoch: number;
};

export type PreparationCheckOutcome = "passed" | "failed";

export type PreparationCheckProblem = {
  readonly code: "unknown-generation";
  readonly label: number;
};

export type PreparationCheckResult = Result.Result<
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

export type ActivationResult = Result.Result<
  {
    readonly generation: Generation;
    readonly epoch: number;
    readonly effect: "activated" | "no-op";
  },
  ActivationProblem
>;
