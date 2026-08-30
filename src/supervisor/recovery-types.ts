export type RecoveryPolicy = {
  readonly maxRepairAttempts: number;
  readonly recoveryBudgetMs: number;
  readonly operationDeadlineMs: number;
};

export type RecoveryFailure = {
  readonly failureEventId: string;
  readonly failedGenerationLabel: number;
};

export type RecoveryOperation = {
  readonly kind: "repair";
  readonly attempt: number;
  readonly key: string;
  readonly deadlineAt: number;
  readonly state: "open" | "needs-reconciliation";
};

export type RecoveryPhase =
  | "blocked"
  | "ready"
  | "repair-open"
  | "needs-reconciliation"
  | "completed";

export type RecoveryEpisode = {
  readonly id: number;
  readonly failure: RecoveryFailure;
  readonly fallbackGenerationLabel: number | undefined;
  readonly policy: RecoveryPolicy;
  readonly startedAt: number;
  readonly recoveryDeadlineAt: number;
  readonly attemptsUsed: number;
  readonly phase: RecoveryPhase;
  readonly result: string;
  readonly errors: readonly string[];
  readonly currentOperation: RecoveryOperation | undefined;
};

export type RepairOperationOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: string };

export type RecoveryOperationReport = {
  readonly applied: boolean;
  readonly episode: RecoveryEpisode;
};
