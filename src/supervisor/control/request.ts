import type { Generation } from "../generations/index.js";

export type GenerationCommand =
  | { readonly kind: "submit-candidate"; readonly harnessCommit: string }
  | { readonly kind: "activate"; readonly label: number; readonly observedEpoch: number }
  | { readonly kind: "rollback"; readonly label: number; readonly observedEpoch: number };

export type ControlProblemCode =
  | "invalid-harness-commit"
  | "invalid-generation-label"
  | "unknown-generation"
  | "not-ready"
  | "not-previously-active"
  | "stale-epoch";

type CommandEffect = "activated" | "no-op";

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
