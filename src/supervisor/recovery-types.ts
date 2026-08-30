import type { HarnessCommit } from "../harness-commit.js";
import type { GenerationLabel } from "./generation-types.js";

export type RecoveryPolicy = {
  readonly maxRepairAttempts: number;
  readonly recoveryBudgetMs: number;
  readonly operationDeadlineMs: number;
};

export type RecoveryFailureInput = {
  readonly failureEventId: string;
  readonly failedGenerationLabel: number;
};

export type RecoveryFailure = {
  readonly failureEventId: string;
  readonly failedGenerationLabel: GenerationLabel;
};

declare const recoveryEpisodeIdBrand: unique symbol;

export type RecoveryEpisodeId = number & {
  readonly [recoveryEpisodeIdBrand]: "RecoveryEpisodeId";
};

type RecoveryEpisodeBase = {
  readonly failure: RecoveryFailure;
  readonly policy: RecoveryPolicy;
  readonly startedAt: number;
  readonly recoveryDeadlineAt: number;
  readonly attemptsUsed: number;
  readonly errors: readonly string[];
};

type RepairOperation = {
  readonly kind: "repair";
  readonly attempt: number;
  readonly key: string;
  readonly deadlineAt: number;
};

type StartupCheckOperation = {
  readonly kind: "startup-check";
  readonly attempt: number;
  readonly key: string;
  readonly deadlineAt: number;
  readonly preparationCheckIdAtOpen: number;
};

export type OpenRepairOperation = RepairOperation & { readonly state: "open" };
export type OpenStartupCheckOperation = StartupCheckOperation & { readonly state: "open" };
type ReconciliationRepairOperation = RepairOperation & { readonly state: "needs-reconciliation" };
type ReconciliationStartupCheckOperation = StartupCheckOperation & {
  readonly state: "needs-reconciliation";
};

export type RecoveryOperation =
  | OpenRepairOperation
  | OpenStartupCheckOperation
  | ReconciliationRepairOperation
  | ReconciliationStartupCheckOperation;

type NoVerifiedCandidate = {
  readonly verifiedHarnessCommit: undefined;
  readonly verifiedGenerationLabel: undefined;
  readonly verifiedPreparationCheckId: undefined;
};

type VerifiedCandidate = {
  readonly verifiedHarnessCommit: HarnessCommit;
  readonly verifiedGenerationLabel: GenerationLabel;
  readonly verifiedPreparationCheckId: number;
};

export type BlockedRecoveryEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: undefined;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: undefined;
    readonly phase: "blocked";
    readonly result: "blocked:no-known-good-generation";
  };

export type ReadyRecoveryEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: undefined;
    readonly phase: "ready";
    readonly result: "fallback-retained:repair-pending" | "repair-failed" | "startup-check-failed";
  };

export type RepairOpenRecoveryEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: OpenRepairOperation;
    readonly phase: "repair-open";
    readonly result: "repair-open";
  };

export type StartupCheckOpenRecoveryEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: HarnessCommit;
    readonly currentOperation: OpenStartupCheckOperation;
    readonly phase: "startup-check-open";
    readonly result: "startup-check-open";
  };

type RepairNeedsReconciliationEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: ReconciliationRepairOperation;
    readonly phase: "needs-reconciliation";
    readonly result: "operation-needs-reconciliation";
  };

type StartupCheckNeedsReconciliationEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: HarnessCommit;
    readonly currentOperation: ReconciliationStartupCheckOperation;
    readonly phase: "needs-reconciliation";
    readonly result: "operation-needs-reconciliation";
  };

export type NeedsReconciliationRecoveryEpisode =
  | RepairNeedsReconciliationEpisode
  | StartupCheckNeedsReconciliationEpisode;

type BoundExhaustedRecoveryEpisode = RecoveryEpisodeBase &
  NoVerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: undefined;
    readonly phase: "completed";
    readonly result:
      | "fallback-retained:repair-attempt-budget-exhausted"
      | "fallback-retained:recovery-budget-exhausted";
  };

type VerifiedRecoveryEpisode = RecoveryEpisodeBase &
  VerifiedCandidate & {
    readonly fallbackGenerationLabel: GenerationLabel;
    readonly repairedHarnessCommit: undefined;
    readonly currentOperation: undefined;
    readonly phase: "completed";
    readonly result: "fallback-retained:repaired-generation-verified";
  };

export type CompletedRecoveryEpisode = BoundExhaustedRecoveryEpisode | VerifiedRecoveryEpisode;

type RecoveryEpisodeDetails =
  | BlockedRecoveryEpisode
  | ReadyRecoveryEpisode
  | RepairOpenRecoveryEpisode
  | StartupCheckOpenRecoveryEpisode
  | NeedsReconciliationRecoveryEpisode
  | CompletedRecoveryEpisode;

type WithId<T> = T extends unknown ? T & { readonly id: RecoveryEpisodeId } : never;

export type RecoveryEpisode = WithId<RecoveryEpisodeDetails>;
export type RecoveryEpisodeDraft = RecoveryEpisodeDetails;

export type StructuredCloneObject = object;
export type RecoveryOperationErrorInput = string | StructuredCloneObject;

export type RecoveryOperationOutcomeInput =
  | { readonly kind: "repair-succeeded"; readonly repairedHarnessCommit: string }
  | { readonly kind: "repair-failed"; readonly error: RecoveryOperationErrorInput }
  | { readonly kind: "startup-check-passed"; readonly generationLabel: number }
  | { readonly kind: "startup-check-failed"; readonly error: RecoveryOperationErrorInput };

export type RecoveryOperationOutcome =
  | { readonly kind: "repair-succeeded"; readonly repairedHarnessCommit: HarnessCommit }
  | { readonly kind: "repair-failed"; readonly error: string }
  | { readonly kind: "startup-check-passed"; readonly generationLabel: GenerationLabel }
  | { readonly kind: "startup-check-failed"; readonly error: string };

export type RecoveryOperationReport = {
  readonly applied: boolean;
  readonly episode: RecoveryEpisode;
};
