import type { Generation } from "../generations/index.js";

export type Principal =
  | { readonly kind: "user" }
  | { readonly kind: "harness"; readonly generationLabel: number };

export type GenerationCommand =
  | { readonly kind: "submit-candidate"; readonly harnessCommit: string }
  | { readonly kind: "activate"; readonly label: number; readonly observedEpoch: number }
  | { readonly kind: "rollback"; readonly label: number; readonly observedEpoch: number };

export type GenerationRequest = {
  readonly principal: Principal;
  readonly command: GenerationCommand;
};

export type ControlProblemCode =
  | "invalid-harness-commit"
  | "invalid-generation-label"
  | "unknown-generation"
  | "not-ready"
  | "not-previously-active"
  | "revoked-capability"
  | "stale-epoch";

export type CommandEffect = "activated" | "no-op";

export type GenerationControlResult =
  | {
      readonly ok: true;
      readonly outcome:
        | {
            readonly kind: "candidate-submitted";
            readonly generation: Generation;
            readonly epoch: number;
          }
        | {
            readonly kind: "activated";
            readonly generation: Generation;
            readonly epoch: number;
            readonly effect: CommandEffect;
          }
        | {
            readonly kind: "rolled-back";
            readonly generation: Generation;
            readonly epoch: number;
            readonly effect: CommandEffect;
          };
    }
  | { readonly ok: false; readonly problem: { readonly code: ControlProblemCode } };
