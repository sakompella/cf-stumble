import type { RecoveryEpisode } from "../supervisor/recovery/index.js";

export type RecoveryReportSupervisor = {
  readonly getLatestRecoveryEpisode: () => Promise<RecoveryEpisode | undefined>;
};

/**
 * What the owner may read about the last recovery episode. It states recorded facts only.
 * `awaitingExternalReport` names the report the Supervisor is still waiting for, because ADR-0032
 * has the Supervisor bound a repair and a startup check that something outside it performs. Nothing
 * here says that a repair is running, and no field carries recorded error text.
 */
export type RecoveryReportSummary = {
  readonly id: number;
  readonly failureEventId: string;
  readonly failedGenerationLabel: number;
  readonly fallbackGenerationLabel: number | null;
  readonly phase: RecoveryEpisode["phase"];
  readonly result: RecoveryEpisode["result"];
  readonly attemptsUsed: number;
  readonly startedAt: number;
  readonly errorCount: number;
  readonly awaitingExternalReport: "repair" | "startup-check" | null;
};

export function recoveryReportSummary(episode: RecoveryEpisode): RecoveryReportSummary {
  const operation = episode.currentOperation;
  return {
    id: episode.id,
    failureEventId: episode.failure.failureEventId,
    failedGenerationLabel: episode.failure.failedGenerationLabel,
    fallbackGenerationLabel: episode.fallbackGenerationLabel ?? null,
    phase: episode.phase,
    result: episode.result,
    attemptsUsed: episode.attemptsUsed,
    startedAt: episode.startedAt,
    errorCount: episode.errors.length,
    awaitingExternalReport: operation?.state === "open" ? operation.kind : null,
  };
}

export async function latestRecoveryReportSummary(
  supervisor: RecoveryReportSupervisor,
): Promise<RecoveryReportSummary | null> {
  const episode = await supervisor.getLatestRecoveryEpisode();
  return episode === undefined ? null : recoveryReportSummary(episode);
}
