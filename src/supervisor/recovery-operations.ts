import type { GenerationLabel } from "./generation-types.js";
import type {
  CompletedRecoveryEpisode,
  NeedsReconciliationRecoveryEpisode,
  ReadyRecoveryEpisode,
  RecoveryEpisodeId,
  RecoveryOperationOutcome,
  RepairOpenRecoveryEpisode,
  StartupCheckOpenRecoveryEpisode,
} from "./recovery-types.js";

export type VerifiedStartupCandidate = {
  readonly harnessCommit: StartupCheckOpenRecoveryEpisode["repairedHarnessCommit"];
  readonly generationLabel: GenerationLabel;
  readonly preparationCheckId: number;
};

type Stored<T> = T & { readonly id: RecoveryEpisodeId };
type RepairSettlementEpisode =
  | Stored<RepairOpenRecoveryEpisode>
  | Stored<
      Extract<
        NeedsReconciliationRecoveryEpisode,
        { readonly currentOperation: { readonly kind: "repair" } }
      >
    >;
type StartupCheckSettlementEpisode =
  | Stored<StartupCheckOpenRecoveryEpisode>
  | Stored<
      Extract<
        NeedsReconciliationRecoveryEpisode,
        { readonly currentOperation: { readonly kind: "startup-check" } }
      >
    >;

export function openRepair(
  episode: Stored<ReadyRecoveryEpisode>,
  now: number,
): Stored<RepairOpenRecoveryEpisode> {
  const attempt = episode.attemptsUsed + 1;
  return {
    ...episode,
    attemptsUsed: attempt,
    phase: "repair-open",
    result: "repair-open",
    currentOperation: {
      kind: "repair",
      attempt,
      key: `recovery-${episode.id}:repair:${attempt}`,
      deadlineAt: boundedOperationDeadline(episode, now),
      state: "open",
    },
  };
}

export function markNeedsReconciliation(
  episode: Stored<RepairOpenRecoveryEpisode> | Stored<StartupCheckOpenRecoveryEpisode>,
): Stored<NeedsReconciliationRecoveryEpisode> {
  if (episode.phase === "repair-open") {
    return {
      ...episode,
      phase: "needs-reconciliation",
      result: "operation-needs-reconciliation",
      errors: [...episode.errors, "operation-deadline-exceeded"],
      currentOperation: { ...episode.currentOperation, state: "needs-reconciliation" },
    };
  }

  return {
    ...episode,
    phase: "needs-reconciliation",
    result: "operation-needs-reconciliation",
    errors: [...episode.errors, "operation-deadline-exceeded"],
    currentOperation: { ...episode.currentOperation, state: "needs-reconciliation" },
  };
}

export function completeForBudget(
  episode: Stored<ReadyRecoveryEpisode>,
  result:
    | "fallback-retained:repair-attempt-budget-exhausted"
    | "fallback-retained:recovery-budget-exhausted",
): Stored<CompletedRecoveryEpisode> {
  return {
    ...episode,
    phase: "completed" as const,
    result,
    currentOperation: undefined,
  };
}

export function settleRepair(
  episode: RepairSettlementEpisode,
  outcome: Extract<
    RecoveryOperationOutcome,
    { readonly kind: "repair-succeeded" | "repair-failed" }
  >,
  now: number,
  preparationCheckIdAtOpen: number,
  mayOpenStartupCheck: boolean,
): Stored<ReadyRecoveryEpisode> | Stored<StartupCheckOpenRecoveryEpisode> {
  if (outcome.kind === "repair-failed") {
    return readyAfterFailure(episode, "repair-failed", outcome.error);
  }

  if (!mayOpenStartupCheck) {
    return readyAfterFailure(
      episode,
      "fallback-retained:repair-pending",
      "recovery-budget-expired-before-startup-check",
    );
  }

  const attempt = episode.currentOperation.attempt;
  return {
    ...episode,
    repairedHarnessCommit: outcome.repairedHarnessCommit,
    phase: "startup-check-open",
    result: "startup-check-open",
    currentOperation: {
      kind: "startup-check",
      attempt,
      key: `recovery-${episode.id}:startup-check:${attempt}`,
      deadlineAt: boundedOperationDeadline(episode, now),
      preparationCheckIdAtOpen,
      state: "open",
    },
  };
}

export function settleStartupCheck(
  episode: StartupCheckSettlementEpisode,
  outcome: Extract<
    RecoveryOperationOutcome,
    { readonly kind: "startup-check-failed" | "startup-check-passed" }
  >,
  verified: VerifiedStartupCandidate | undefined,
): Stored<ReadyRecoveryEpisode> | Stored<CompletedRecoveryEpisode> | undefined {
  if (outcome.kind === "startup-check-failed") {
    return readyAfterFailure(episode, "startup-check-failed", outcome.error);
  }

  return verified === undefined ? undefined : verifiedEpisode(episode, verified);
}

function readyAfterFailure(
  episode: RepairSettlementEpisode | StartupCheckSettlementEpisode,
  result: ReadyRecoveryEpisode["result"],
  error: string,
): Stored<ReadyRecoveryEpisode> {
  return {
    ...episode,
    repairedHarnessCommit: undefined,
    phase: "ready",
    result,
    errors: [...episode.errors, error],
    currentOperation: undefined,
  };
}

function verifiedEpisode(
  episode: StartupCheckSettlementEpisode,
  verified: VerifiedStartupCandidate,
): Stored<CompletedRecoveryEpisode> {
  return {
    ...episode,
    repairedHarnessCommit: undefined,
    verifiedHarnessCommit: verified.harnessCommit,
    verifiedGenerationLabel: verified.generationLabel,
    verifiedPreparationCheckId: verified.preparationCheckId,
    phase: "completed" as const,
    result: "fallback-retained:repaired-generation-verified" as const,
    currentOperation: undefined,
  };
}

function boundedOperationDeadline(
  episode: Stored<ReadyRecoveryEpisode> | RepairSettlementEpisode,
  now: number,
): number {
  const requested =
    now > Number.MAX_SAFE_INTEGER - episode.policy.operationDeadlineMs
      ? Number.MAX_SAFE_INTEGER
      : now + episode.policy.operationDeadlineMs;
  return Math.min(requested, episode.recoveryDeadlineAt);
}
