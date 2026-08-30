export type GenerationStatus = "candidate" | "ready" | "failed";

export type Generation = {
  readonly label: number;
  readonly harnessCommit: string;
  readonly status: GenerationStatus;
};

export type ActiveGeneration = {
  readonly generation: Generation | undefined;
  readonly epoch: number;
};

export type LabelGenerationResult =
  | {
      readonly ok: true;
      readonly generation: Generation;
      readonly epoch: number;
    }
  | {
      readonly ok: false;
      readonly problem: {
        readonly code: "invalid-harness-commit";
        readonly harnessCommit: string;
      };
    };

export type PreparationCheckOutcome = "passed" | "failed";

export type PreparationCheckResult =
  | {
      readonly ok: true;
      readonly generation: Generation;
      readonly epoch: number;
      readonly effect: "recorded" | "no-op";
    }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: "invalid-generation-label"; readonly label: number }
        | { readonly code: "unknown-generation"; readonly label: number }
        | { readonly code: "invalid-preparation-check-outcome" }
        | {
            readonly code: "contradicts-recorded-outcome";
            readonly label: number;
            readonly recorded: GenerationStatus;
          };
    };

export type ActivationResult =
  | {
      readonly ok: true;
      readonly generation: Generation;
      readonly epoch: number;
      readonly effect: "activated" | "no-op";
    }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: "invalid-generation-label"; readonly label: number }
        | { readonly code: "unknown-generation"; readonly label: number }
        | { readonly code: "not-ready"; readonly label: number };
    };
