import { Result, type Result as ResultType } from "better-result";
import { assertNever, type Sha } from "../git/types.js";
import type { Attestation, GenerationNumber, Verdict } from "../generation/types.js";
import type { GenerationRegistry, MaterializationTransition } from "../generation/registry.js";
import type { EffectsDifference, ReplaySession } from "../replay/index.js";
import type { PointerStore, StorageUnavailableError } from "../storage/types.js";
import {
  type PinnedCanary,
  type ValidationCase,
  type ValidationCaseResult,
  type ValidationExecutor,
  type PreflightResult,
  type PreflightRunner,
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
  readonly pinnedCanaries?: readonly PinnedCanary[];
  readonly execute: ValidationExecutor;
  readonly preflight?: PreflightRunner;
  readonly generationRegistry?: Pick<GenerationRegistry, "transition">;
  readonly executorTimeoutMs?: number;
  readonly now?: () => number;
};

export type ValidationRun = {
  readonly result: ValidationResult;
  readonly attestation: Attestation | undefined;
};

export type ValidationIdentity = {
  readonly generation: GenerationNumber;
  readonly artifactDigest: Sha;
  readonly validatedAgainstGeneration: GenerationNumber | undefined;
};

export class ValidationGate {
  private readonly pointerStore: PointerStore;
  private readonly resultStore: ValidationResultStore;
  private readonly corpus: readonly ValidationCase[];
  private readonly pinnedCanaries: readonly PinnedCanary[];
  private readonly execute: ValidationExecutor;
  private readonly preflight: PreflightRunner | undefined;
  private readonly generationRegistry: Pick<GenerationRegistry, "transition"> | undefined;
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
    this.preflight = options.preflight;
    this.generationRegistry = options.generationRegistry;
    this.executorTimeoutMs = validateExecutorTimeout(options.executorTimeoutMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  async validate(
    candidate: Sha,
    validationIdentity: ValidationIdentity,
  ): Promise<ResultType<ValidationRun, StorageUnavailableError>> {
    const preflight = await executePreflight(this.preflight, candidate);
    await recordPreflightFailure(this.generationRegistry, preflight, validationIdentity);
    const pointer = await this.pointerStore.readPointer();
    if (Result.isError(pointer)) {
      return pointer;
    }
    const [corpusVersion, gateVersion, pinnedCorpusMatches] = await Promise.all([
      computeCorpusVersion(this.corpus),
      computeGateVersion(),
      corpusContainsPinnedCanaries(this.corpus, this.pinnedCanaries),
    ]);
    const validatedAgainst = pointer.value;
    const caseResults =
      preflight === undefined || preflight.status === "PASS"
        ? pinnedCorpusMatches
          ? await runCases(
              this.execute,
              candidate,
              validatedAgainst,
              evaluationCases(this.corpus, this.pinnedCanaries),
              this.executorTimeoutMs,
            )
          : []
        : [];

    const result = makeValidationResult(
      candidate,
      validationIdentity,
      validatedAgainst,
      corpusVersion,
      gateVersion,
      caseResults,
      this.now(),
      preflight,
    );
    await this.resultStore.put(result);
    return Result.ok({ result, attestation: passingAttestation(result) });
  }
}

async function recordPreflightFailure(
  generationRegistry: Pick<GenerationRegistry, "transition"> | undefined,
  preflight: PreflightResult | undefined,
  identity: ValidationIdentity,
): Promise<void> {
  if (generationRegistry === undefined || preflight === undefined || preflight.status === "PASS") {
    return;
  }
  const failure = preflight.failure ?? `preflight ${preflight.status.toLowerCase()}`;
  const transition: MaterializationTransition = hasMaterializationFailure(preflight)
    ? { state: "load_failed", artifactDigest: identity.artifactDigest, failure }
    : { state: "validation_failed", failure };
  const result = await generationRegistry.transition(identity.generation, transition);
  if (result.outcome === "rejected") {
    throw new Error(
      `could not record preflight ${preflight.status.toLowerCase()} for generation ${identity.generation}: ${result.reason.kind}`,
    );
  }
}

function hasMaterializationFailure(preflight: PreflightResult): boolean {
  return preflight.checks.some(
    (check) => check.capability === "materialization" && check.status === "FAIL",
  );
}

async function executePreflight(
  preflight: PreflightRunner | undefined,
  candidate: Sha,
): Promise<PreflightResult | undefined> {
  if (preflight === undefined) {
    return undefined;
  }
  try {
    return await preflight(candidate);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "INCONCLUSIVE",
      checks: [
        {
          capability: "materialization",
          status: "INCONCLUSIVE",
          detail: `preflight harness error: ${detail}`,
        },
      ],
      failure: `preflight harness error: ${detail}`,
    };
  }
}

function makeValidationResult(
  candidate: Sha,
  identity: ValidationIdentity,
  validatedAgainst: Sha | undefined,
  corpusVersion: string,
  gateVersion: string,
  caseResults: readonly ValidationCaseResult[],
  createdAt: number,
  preflight: PreflightResult | undefined,
): ValidationResult {
  const preflightEvidence = preflight === undefined ? {} : { preflight };
  return {
    candidate,
    generation: identity.generation,
    artifactDigest: identity.artifactDigest,
    validatedAgainst,
    validatedAgainstGeneration: identity.validatedAgainstGeneration,
    corpusVersion,
    gateVersion,
    verdict: evaluateVerdict(preflight, caseResults),
    createdAt,
    caseResults,
    ...preflightEvidence,
  };
}

function evaluateVerdict(
  preflight: PreflightResult | undefined,
  caseResults: readonly ValidationCaseResult[],
): Verdict {
  if (preflight === undefined) {
    return evaluateRatchet(caseResults);
  }
  switch (preflight.status) {
    case "PASS":
      return evaluateRatchet(caseResults);
    case "FAIL":
      return "fail";
    case "INCONCLUSIVE":
      return "inconclusive";
    default:
      return assertNever(preflight.status, "preflight status");
  }
}

function passingAttestation(result: ValidationResult): Attestation | undefined {
  if (result.verdict !== "pass") {
    return undefined;
  }
  return {
    candidate: result.candidate,
    generation: result.generation,
    artifactDigest: result.artifactDigest,
    validatedAgainst: result.validatedAgainst,
    validatedAgainstGeneration: result.validatedAgainstGeneration,
    corpusVersion: result.corpusVersion,
    gateVersion: result.gateVersion,
    verdict: result.verdict,
    createdAt: result.createdAt,
  };
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
