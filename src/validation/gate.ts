import type { Sha } from "../git/types.js";
import type { Attestation, Verdict } from "../generation/types.js";
import type { EffectsDifference } from "../replay/comparison.js";
import type { ReplaySession } from "../replay/index.js";
import type { PointerStore } from "../storage/types.js";
import {
  type PinnedCanary,
  type ValidationCase,
  type ValidationCaseResult,
  type ValidationExecutor,
  type ValidationResult,
  type ValidationResultStore,
} from "./results.js";
import {
  corpusContainsPinnedCanaries,
  evaluationCases,
  validateCorpus,
  validateExecutorTimeout,
  validatePinnedCanaries,
} from "./canaries.js";
import { executeSafely, recordOutcome } from "./execution.js";
import { computeCorpusVersion, computeGateVersion } from "./versions.js";

export type ValidationGateOptions = {
  readonly pointerStore: PointerStore;
  readonly resultStore: ValidationResultStore;
  readonly corpus: readonly ValidationCase[];
  /** Supervisor-owned canaries; corpus metadata cannot add, remove, or alter these cases. */
  readonly pinnedCanaries?: readonly PinnedCanary[];
  readonly execute: ValidationExecutor;
  readonly executorTimeoutMs?: number;
  readonly now?: () => number;
};

export type ValidationRun = {
  readonly result: ValidationResult;
  readonly attestation: Attestation | undefined;
};

export class ValidationGate {
  private readonly pointerStore: PointerStore;
  private readonly resultStore: ValidationResultStore;
  private readonly corpus: readonly ValidationCase[];
  private readonly pinnedCanaries: readonly PinnedCanary[];
  private readonly execute: ValidationExecutor;
  private readonly executorTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: ValidationGateOptions) {
    validateCorpus(options.corpus);
    const pinnedCanaries = options.pinnedCanaries ?? [];
    validatePinnedCanaries(pinnedCanaries);
    this.pointerStore = options.pointerStore;
    this.resultStore = options.resultStore;
    this.corpus = [...options.corpus];
    this.pinnedCanaries = [...pinnedCanaries];
    this.execute = options.execute;
    this.executorTimeoutMs = validateExecutorTimeout(options.executorTimeoutMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  async validate(candidate: Sha): Promise<ValidationRun> {
    const [corpusVersion, gateVersion, validatedAgainst, pinnedCorpusMatches] = await Promise.all([
      computeCorpusVersion(this.corpus),
      computeGateVersion(),
      this.pointerStore.readPointer(),
      corpusContainsPinnedCanaries(this.corpus, this.pinnedCanaries),
    ]);
    const caseResults = pinnedCorpusMatches
      ? await runCases(
          this.execute,
          candidate,
          validatedAgainst,
          evaluationCases(this.corpus, this.pinnedCanaries),
          this.executorTimeoutMs,
        )
      : [];

    const result: ValidationResult = {
      candidate,
      validatedAgainst,
      corpusVersion,
      gateVersion,
      verdict: evaluateRatchet(caseResults),
      createdAt: this.now(),
      caseResults,
    };
    await this.resultStore.put(result);
    const attestation =
      result.verdict === "pass"
        ? {
            candidate: result.candidate,
            validatedAgainst: result.validatedAgainst,
            corpusVersion: result.corpusVersion,
            gateVersion: result.gateVersion,
            verdict: result.verdict,
            createdAt: result.createdAt,
          }
        : undefined;
    return { result, attestation };
  }
}

async function runCases(
  execute: ValidationExecutor,
  candidate: Sha,
  validatedAgainst: Sha | undefined,
  cases: readonly ValidationCase[],
  timeoutMs: number,
): Promise<readonly ValidationCaseResult[]> {
  const caseResults: ValidationCaseResult[] = [];
  for (const validationCase of cases) {
    const baseline = await executeSafely(
      execute,
      validatedAgainst,
      validationCase.session,
      timeoutMs,
    );
    const candidateOutcome = await executeSafely(
      execute,
      candidate,
      validationCase.session,
      timeoutMs,
    );
    caseResults.push({
      name: validationCase.name,
      mandatoryCanary: validationCase.mandatoryCanary,
      baseline: recordOutcome(baseline),
      candidate: recordOutcome(candidateOutcome),
    });
  }
  return caseResults;
}

function evaluateRatchet(caseResults: readonly ValidationCaseResult[]): Verdict {
  if (caseResults.length === 0) {
    return "inconclusive";
  }
  if (
    caseResults.some(
      (caseResult) =>
        caseResult.baseline.status === "INCONCLUSIVE" ||
        caseResult.candidate.status === "INCONCLUSIVE",
    )
  ) {
    return "inconclusive";
  }
  if (!caseResults.some((caseResult) => caseResult.baseline.status === "PASS")) {
    return "inconclusive";
  }

  for (const caseResult of caseResults) {
    if (caseResult.mandatoryCanary && caseResult.candidate.status === "FAIL") {
      return "fail";
    }
  }
  for (const caseResult of caseResults) {
    if (caseResult.mandatoryCanary && caseResult.baseline.status !== "PASS") {
      return "inconclusive";
    }
  }
  for (const caseResult of caseResults) {
    if (caseResult.baseline.status === "PASS" && caseResult.candidate.status === "FAIL") {
      return "fail";
    }
  }
  return "pass";
}

export type { EffectsDifference, ReplaySession };
