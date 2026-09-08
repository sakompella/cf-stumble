/**
 * Two questions, two predicates, one file so a later reader sees that they are different.
 *
 * `servedSuccessfulResponse` asks whether a generation served a good response, which is ADR-0031's
 * relay fact and decides whether a generation is known good. `earnsCompletedRealTurnCredit` asks
 * whether one project turn completed and was saved, which is goal criterion 6's durability fact.
 * Only the first feeds {@link deriveGenerationEligibility}: a thread-save failure must never make
 * a healthy harness generation ineligible.
 */

import { invariant } from "../invariant.js";
import { parseGenerationLabel } from "./generations/index.js";
import type { GenerationLabel } from "./generations/index.js";
import type { PreparationCheck } from "./generations/index.js";
import type { RelayAttempt } from "./relay/index.js";

export type EligibilityPolicy = {
  readonly minimumCreditedTurns: number;
  readonly minimumObservationSpanMs: number;
};

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  minimumCreditedTurns: 3,
  minimumObservationSpanMs: 60_000,
};

export type GenerationEligibility =
  | {
      readonly kind: "eligible";
      readonly creditedTurns: number;
      readonly observationSpanMs: number;
    }
  | {
      readonly kind: "ineligible";
      readonly reason:
        | "startup-check-required"
        | "failure-observed"
        | "insufficient-credited-turns"
        | "insufficient-observation-span";
      readonly creditedTurns: number;
      readonly observationSpanMs: number;
    };

export type GenerationEligibilityEvidence = {
  readonly generationLabel: GenerationLabel;
  readonly latestActivationId: number | undefined;
  readonly latestPreparationCheck: PreparationCheck | undefined;
  readonly attempts: readonly RelayAttempt[];
};

type SuccessfulResponseAttempt = RelayAttempt & {
  readonly outcome: "body-completed";
  readonly responseStatus: number;
  readonly finishedAt: number;
};

/**
 * The facts one project turn ends with, for the second of the two questions this module answers.
 *
 * Read {@link earnsCompletedRealTurnCredit} for what separates them. This record is assembled by
 * the turn shell (`projects/turn-run.ts`) at the moment the thread commit returns, which is the
 * only moment at which all three facts are known.
 */
export type CompletedRealTurnEvidence = Readonly<{
  /** The relay attempt this turn was recorded as, with the transport facts it has so far. */
  attempt: RelayAttempt;
  /** Pi's terminal frame said `completed`. On its own this is provisional (ADR-0037). */
  piTerminalSuccess: boolean;
  /** The thread save for this turn's lease returned committed. Nothing else proves durability. */
  threadSaveCommitted: boolean;
}>;

export function selectFallbackGeneration(
  failedGenerationLabel: GenerationLabel,
  candidates: readonly GenerationEligibilityEvidence[],
  policy: EligibilityPolicy,
): GenerationLabel | undefined {
  return candidates
    .toReversed()
    .find(
      (candidate) =>
        candidate.generationLabel !== failedGenerationLabel &&
        deriveGenerationEligibility(candidate, policy).kind === "eligible",
    )?.generationLabel;
}

/** The generation history this derivation reads. `Generations` satisfies it. */
export interface GenerationEvidenceHistory {
  latestActivationId(label: GenerationLabel): number | undefined;
  latestPreparationCheck(label: GenerationLabel): PreparationCheck | undefined;
}

/**
 * Collect one generation's evidence and derive its verdict. A label that is not a generation label
 * has no evidence at all, so it reports the same `startup-check-required` an unchecked generation
 * reports rather than failing the call.
 */
export function generationEligibility(
  label: number,
  history: GenerationEvidenceHistory,
  attempts: readonly RelayAttempt[],
  policy: EligibilityPolicy,
): GenerationEligibility {
  const generationLabel = parseGenerationLabel(label);
  if (generationLabel === undefined) {
    return ineligible("startup-check-required", 0, 0);
  }

  return deriveGenerationEligibility(
    {
      generationLabel,
      latestActivationId: history.latestActivationId(generationLabel),
      latestPreparationCheck: history.latestPreparationCheck(generationLabel),
      attempts,
    },
    policy,
  );
}

export function deriveGenerationEligibility(
  evidence: GenerationEligibilityEvidence,
  policy: EligibilityPolicy,
): GenerationEligibility {
  validatePolicy(policy);
  const preparationCheck = evidence.latestPreparationCheck;
  const activationId = evidence.latestActivationId;
  if (preparationCheck === undefined || activationId === undefined) {
    return ineligible("startup-check-required", 0, 0);
  }

  const attempts = evidence.attempts.filter((attempt) =>
    belongsToMostRecentEra(attempt, evidence.generationLabel, activationId, preparationCheck),
  );
  const credited = attempts.filter((attempt) => servedSuccessfulResponse(attempt));
  const observationSpanMs = creditedSpan(credited);

  if (attempts.some((attempt) => isFailureObservation(attempt))) {
    return ineligible("failure-observed", credited.length, observationSpanMs);
  }

  if (credited.length < policy.minimumCreditedTurns) {
    return ineligible("insufficient-credited-turns", credited.length, observationSpanMs);
  }

  if (observationSpanMs < policy.minimumObservationSpanMs) {
    return ineligible("insufficient-observation-span", credited.length, observationSpanMs);
  }

  return { kind: "eligible", creditedTurns: credited.length, observationSpanMs };
}

function belongsToMostRecentEra(
  attempt: RelayAttempt,
  generationLabel: GenerationLabel,
  activationId: number,
  preparationCheck: PreparationCheck,
): boolean {
  return (
    attempt.generationLabel === generationLabel &&
    attempt.activationId === activationId &&
    attempt.preparationCheckId === preparationCheck.id
  );
}

/**
 * Question one: did this generation serve a successful response? This is a transport fact and
 * ADR-0031's evidence for whether a generation is known good: a completed body under 400. It says
 * nothing about whether a conversation was saved, and it must not: a thread-save failure is the
 * Supervisor's storage fault and would make a healthy harness look broken if it were folded in
 * here.
 *
 * A completed body under 400 is not enough on its own, because a project turn carries its own
 * ending inside a 200: a turn Pi rejected and a turn that failed on a model error both stream a
 * clean body, so counting them would let three refusals qualify a generation that never completed
 * any work. The turn terminal the attempt records is the missing fact, and it is read closed: an
 * attempt earns credit only when it carried no turn at all or carried one that completed.
 */
function servedSuccessfulResponse(attempt: RelayAttempt): attempt is SuccessfulResponseAttempt {
  return (
    attempt.outcome === "body-completed" &&
    attempt.responseStatus < 400 &&
    (attempt.turnTerminal === undefined || attempt.turnTerminal === "completed")
  );
}

/**
 * Question two: did one real turn complete? This is a durability fact, and it is goal criterion
 * 6's: "Success requires Pi terminal success and a committed thread save. A rejected, failed,
 * truncated, cancelled, or unsaved turn earns no completed-real-turn credit."
 *
 * The two questions are deliberately not one predicate. {@link servedSuccessfulResponse} decides
 * whether a generation is trustworthy from what the relay observed; this decides whether the user
 * got a turn that survived. A turn can serve a flawless 200 and save nothing, and the harness is
 * still healthy while the turn earned nothing. Merging them would either credit unsaved turns
 * against goal criterion 6 or make a storage failure count as harness evidence against ADR-0031.
 *
 * Transport still has a veto: a stream the browser cancelled, or one that failed after its
 * headers, did not deliver the turn it saved, so it earns nothing even when the save committed.
 */
export function earnsCompletedRealTurnCredit(evidence: CompletedRealTurnEvidence): boolean {
  return (
    evidence.piTerminalSuccess &&
    evidence.threadSaveCommitted &&
    isDeliveringSuccessfully(evidence.attempt)
  );
}

/** The transport half of {@link earnsCompletedRealTurnCredit}, at the moment of the commit. */
function isDeliveringSuccessfully(attempt: RelayAttempt): boolean {
  const delivering = attempt.outcome === "pending" || attempt.outcome === "body-completed";
  return delivering && (attempt.responseStatus === undefined || attempt.responseStatus < 400);
}

/**
 * Blame, which is not the complement of credit. A turn Pi rejected and a turn that failed on a
 * model error earn neither: the model refusing a request or erroring is not evidence that the
 * harness code is broken, so recording either as a failed body would wrongly make the generation
 * ineligible for `failure-observed` rather than merely uncredited (ADR-0031).
 */
function isFailureObservation(attempt: RelayAttempt): boolean {
  return (
    attempt.outcome === "pre-header-failure" ||
    attempt.outcome === "body-failed" ||
    (attempt.outcome === "body-completed" && attempt.responseStatus >= 500)
  );
}

function creditedSpan(attempts: readonly SuccessfulResponseAttempt[]): number {
  return attempts.length < 2
    ? 0
    : Math.max(...attempts.map((attempt) => attempt.finishedAt)) -
        Math.min(...attempts.map((attempt) => attempt.finishedAt));
}

function ineligible(
  reason: Extract<GenerationEligibility, { readonly kind: "ineligible" }>["reason"],
  creditedTurns: number,
  observationSpanMs: number,
): GenerationEligibility {
  return { kind: "ineligible", reason, creditedTurns, observationSpanMs };
}

function validatePolicy(policy: EligibilityPolicy): void {
  invariant(
    Number.isSafeInteger(policy.minimumCreditedTurns) && policy.minimumCreditedTurns >= 1,
    "minimumCreditedTurns must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.minimumObservationSpanMs) && policy.minimumObservationSpanMs >= 0,
    "minimumObservationSpanMs must be a non-negative safe integer",
  );
}
