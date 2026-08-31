import { DEFAULT_ELIGIBILITY_POLICY, deriveGenerationEligibility } from "./eligibility.js";
import type { EligibilityPolicy } from "./eligibility.js";
import { verifiedStartupCandidate } from "./recovery-candidate.js";
import type { GenerationLabel } from "./generations/index.js";
import type { Generations } from "./generations/index.js";
import {
  blockedEpisode,
  parseRecoveryOperationOutcome,
  readyEpisode,
  validateEpisodeId,
  validateFailure,
  validateNow,
  validateRecoveryDeadline,
  validateRecoveryPolicy,
  withEpisodeId,
} from "./recovery-model.js";
import {
  completeForBudget,
  markNeedsReconciliation,
  openRepair,
  settleRepair,
  settleStartupCheck,
} from "./recovery-operations.js";
import type { RelayAttempts } from "./relay-attempts.js";
import { RecoveryEpisodeStore } from "./recovery-store.js";
import type {
  RecoveryEpisode,
  RecoveryFailureInput,
  RecoveryOperationOutcome,
  RecoveryOperationOutcomeInput,
  RecoveryOperationReport,
  RecoveryPolicy,
} from "./recovery-types.js";

type RepairSettlementEpisode = Extract<
  RecoveryEpisode,
  { readonly currentOperation: { readonly kind: "repair" } }
>;
type StartupCheckSettlementEpisode = Extract<
  RecoveryEpisode,
  { readonly currentOperation: { readonly kind: "startup-check" } }
>;

export type {
  CompletedRecoveryEpisode,
  RecoveryEpisode,
  RecoveryFailure,
  RecoveryFailureInput,
  RecoveryOperation,
  RecoveryOperationOutcomeInput,
  RecoveryOperationReport,
  RecoveryPolicy,
} from "./recovery-types.js";
export { validateRecoveryPolicy } from "./recovery-model.js";

export class Recovery {
  private readonly storage: DurableObjectStorage;
  private readonly generations: Generations;
  private readonly relayAttempts: RelayAttempts;
  private readonly episodeStore: RecoveryEpisodeStore;

  constructor(
    storage: DurableObjectStorage,
    generations: Generations,
    relayAttempts: RelayAttempts,
  ) {
    this.storage = storage;
    this.generations = generations;
    this.relayAttempts = relayAttempts;
    this.episodeStore = new RecoveryEpisodeStore(storage);
  }

  start(
    failure: RecoveryFailureInput,
    policy: RecoveryPolicy,
    now: number,
    eligibilityPolicy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
  ): RecoveryEpisode {
    const parsedFailure = validateFailure(failure);
    validateNow(now);
    return this.storage.transactionSync(() => {
      const existing = this.episodeStore.byFailureEventId(parsedFailure.failureEventId);
      if (existing !== undefined) {
        if (existing.failure.failedGenerationLabel !== parsedFailure.failedGenerationLabel) {
          throw new Error(
            `failure event ID already belongs to generation ${existing.failure.failedGenerationLabel}`,
          );
        }
        return existing;
      }
      validateRecoveryPolicy(policy);
      validateRecoveryDeadline(now, policy);
      const fallbackGenerationLabel = this.chooseFallback(
        parsedFailure.failedGenerationLabel,
        eligibilityPolicy,
      );
      const draft =
        fallbackGenerationLabel === undefined
          ? blockedEpisode(parsedFailure, policy, now)
          : readyEpisode(parsedFailure, fallbackGenerationLabel, policy, now);
      return withEpisodeId(draft, this.episodeStore.insert(draft));
    });
  }

  resume(id: number, now: number): RecoveryEpisode {
    validateEpisodeId(id);
    validateNow(now);
    return this.storage.transactionSync(() => this.advance(this.requiredById(id), now));
  }

  reportOperation(
    id: number,
    key: string,
    outcome: RecoveryOperationOutcomeInput,
    now: number,
  ): RecoveryOperationReport {
    validateEpisodeId(id);
    validateNow(now);
    const parsedOutcome = parseRecoveryOperationOutcome(outcome);
    return this.storage.transactionSync(() =>
      this.report(this.requiredById(id), key, parsedOutcome, now),
    );
  }

  reconcileOperation(
    id: number,
    key: string,
    outcome: RecoveryOperationOutcomeInput,
    now: number,
  ): RecoveryOperationReport {
    validateEpisodeId(id);
    validateNow(now);
    const parsedOutcome = parseRecoveryOperationOutcome(outcome);
    return this.storage.transactionSync(() => {
      const episode = this.requiredById(id);
      this.validateEpisodeTime(episode, now);
      const operation = episode.currentOperation;
      if (
        parsedOutcome === undefined ||
        operation === undefined ||
        operation.key !== key ||
        operation.state !== "needs-reconciliation"
      ) {
        return { applied: false, episode };
      }
      return this.settle(episode, parsedOutcome, now);
    });
  }

  get(id: number): RecoveryEpisode | undefined {
    return Number.isSafeInteger(id) && id > 0 ? this.episodeStore.byId(id) : undefined;
  }

  private report(
    episode: RecoveryEpisode,
    key: string,
    outcome: RecoveryOperationOutcome | undefined,
    now: number,
  ): RecoveryOperationReport {
    this.validateEpisodeTime(episode, now);
    const operation = episode.currentOperation;
    if (
      outcome === undefined ||
      operation === undefined ||
      operation.key !== key ||
      operation.state !== "open"
    ) {
      return { applied: false, episode };
    }
    if (now >= operation.deadlineAt) {
      return { applied: false, episode: this.advance(episode, now) };
    }
    return this.settle(episode, outcome, now);
  }

  private settle(
    episode: RecoveryEpisode,
    outcome: RecoveryOperationOutcome,
    now: number,
  ): RecoveryOperationReport {
    this.validateEpisodeTime(episode, now);
    if (isRepairSettlementEpisode(episode)) {
      if (outcome.kind !== "repair-succeeded" && outcome.kind !== "repair-failed") {
        return { applied: false, episode };
      }
      const preparationCheckIdAtOpen =
        outcome.kind === "repair-succeeded" ? this.generations.latestPreparationCheckId() : 0;
      const settled = settleRepair(
        episode,
        outcome,
        now,
        preparationCheckIdAtOpen,
        now < episode.recoveryDeadlineAt,
      );
      this.episodeStore.store(settled);
      return { applied: true, episode: settled };
    }
    if (isStartupCheckSettlementEpisode(episode)) {
      if (outcome.kind !== "startup-check-passed" && outcome.kind !== "startup-check-failed") {
        return { applied: false, episode };
      }
      const settled = settleStartupCheck(
        episode,
        outcome,
        verifiedStartupCandidate(this.generations, episode, outcome),
      );
      if (settled === undefined) {
        return { applied: false, episode };
      }
      this.episodeStore.store(settled);
      return { applied: true, episode: settled };
    }
    return { applied: false, episode };
  }

  private advance(episode: RecoveryEpisode, now: number): RecoveryEpisode {
    this.validateEpisodeTime(episode, now);
    if (episode.phase === "blocked" || episode.phase === "completed") {
      return episode;
    }
    if (episode.phase === "repair-open" || episode.phase === "startup-check-open") {
      return now >= episode.currentOperation.deadlineAt
        ? this.storeAndReturn(markNeedsReconciliation(episode))
        : episode;
    }
    if (episode.phase === "needs-reconciliation") {
      return episode;
    }
    if (now >= episode.recoveryDeadlineAt) {
      return this.storeAndReturn(
        completeForBudget(episode, "fallback-retained:recovery-budget-exhausted"),
      );
    }
    if (episode.attemptsUsed >= episode.policy.maxRepairAttempts) {
      return this.storeAndReturn(
        completeForBudget(episode, "fallback-retained:repair-attempt-budget-exhausted"),
      );
    }
    return this.storeAndReturn(openRepair(episode, now));
  }

  private validateEpisodeTime(episode: RecoveryEpisode, now: number): void {
    if (now < episode.startedAt) {
      throw new RangeError("recovery time cannot precede episode start");
    }
  }

  private storeAndReturn(episode: RecoveryEpisode): RecoveryEpisode {
    this.episodeStore.store(episode);
    return episode;
  }

  private chooseFallback(
    failedGenerationLabel: GenerationLabel,
    policy: EligibilityPolicy,
  ): GenerationLabel | undefined {
    const attempts = this.relayAttempts.all();
    return this.generations
      .all()
      .toReversed()
      .find(
        (generation) =>
          generation.label !== failedGenerationLabel &&
          deriveGenerationEligibility(
            {
              generationLabel: generation.label,
              latestActivationId: this.generations.latestActivationId(generation.label),
              latestPreparationCheck: this.generations.latestPreparationCheck(generation.label),
              attempts,
            },
            policy,
          ).kind === "eligible",
      )?.label;
  }

  private requiredById(id: number): RecoveryEpisode {
    const episode = this.episodeStore.byId(id);
    if (episode === undefined) {
      throw new Error(`unknown recovery: ${id}`);
    }
    return episode;
  }
}

function isRepairSettlementEpisode(episode: RecoveryEpisode): episode is RepairSettlementEpisode {
  return episode.currentOperation?.kind === "repair";
}

function isStartupCheckSettlementEpisode(
  episode: RecoveryEpisode,
): episode is StartupCheckSettlementEpisode {
  return episode.currentOperation?.kind === "startup-check";
}
