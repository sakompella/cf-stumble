import type { Generation, Generations, PreparationCheck } from "../generations/index.js";
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
  const label = outcome.kind === "startup-check-passed" ? outcome.generationLabel : undefined;
  const generation = label === undefined ? undefined : generations.byLabel(label);
  const latestPreparationCheck =
    label === undefined ? undefined : generations.latestPreparationCheck(label);
  return decideVerifiedStartupCandidate(episode, outcome, generation, latestPreparationCheck);
}

export function decideVerifiedStartupCandidate(
  episode: StartupCheckSettlementEpisode,
  outcome: RecoveryOperationOutcome,
  generation: Generation | undefined,
  latestPreparationCheck: PreparationCheck | undefined,
): VerifiedStartupCandidate | undefined {
  if (
    outcome.kind !== "startup-check-passed" ||
    outcome.generationLabel === episode.failure.failedGenerationLabel ||
    outcome.generationLabel === episode.fallbackGenerationLabel
  ) {
    return undefined;
  }
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
