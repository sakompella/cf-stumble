import type { Generations } from "../generations/index.js";
import type { VerifiedStartupCandidate } from "./operations.js";
import type { RecoveryEpisode, RecoveryOperationOutcome } from "./episode.js";

type StartupCheckSettlementEpisode = Extract<
  RecoveryEpisode,
  { readonly currentOperation: { readonly kind: "startup-check" } }
>;

export function verifiedStartupCandidate(
  generations: Generations,
  episode: StartupCheckSettlementEpisode,
  outcome: RecoveryOperationOutcome,
): VerifiedStartupCandidate | undefined {
  if (
    outcome.kind !== "startup-check-passed" ||
    outcome.generationLabel === episode.failure.failedGenerationLabel ||
    outcome.generationLabel === episode.fallbackGenerationLabel
  ) {
    return undefined;
  }
  const generation = generations.byLabel(outcome.generationLabel);
  const latestPreparationCheck = generations.latestPreparationCheck(outcome.generationLabel);
  if (
    generation === undefined ||
    generation.harnessCommit !== episode.repairedHarnessCommit ||
    generation.status !== "ready" ||
    latestPreparationCheck?.outcome !== "passed" ||
    latestPreparationCheck.id <= episode.currentOperation.preparationCheckIdAtOpen
  ) {
    return undefined;
  }
  return {
    harnessCommit: generation.harnessCommit,
    generationLabel: generation.label,
    preparationCheckId: latestPreparationCheck.id,
  };
}
