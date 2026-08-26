import { assertNever } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { Attestation, Verdict } from "../generation/types.js";
import type { EffectsDifference } from "../replay/comparison.js";
import type {
  ReplayInconclusiveReason,
  ReplayOutcome,
  ReplaySession,
} from "../replay/index.js";
import type { PointerStore } from "../storage/types.js";
import {
  type RecordedCaseOutcome,
  type ValidationCase,
  type ValidationCaseResult,
  type ValidationExecutor,
  type ValidationResult,
  type ValidationResultStore,
} from "./results.js";
import { computeCorpusVersion, computeGateVersion } from "./versions.js";

export type ValidationGateOptions = {
  readonly pointerStore: PointerStore;
  readonly resultStore: ValidationResultStore;
  readonly corpus: readonly ValidationCase[];
  readonly execute: ValidationExecutor;
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
  private readonly execute: ValidationExecutor;
  private readonly now: () => number;

  constructor(options: ValidationGateOptions) {
    validateCorpus(options.corpus);
    this.pointerStore = options.pointerStore;
    this.resultStore = options.resultStore;
    this.corpus = [...options.corpus];
    this.execute = options.execute;
    this.now = options.now ?? Date.now;
  }

  async validate(candidate: Sha): Promise<ValidationRun> {
    const [corpusVersion, gateVersion, validatedAgainst] = await Promise.all([
      computeCorpusVersion(this.corpus),
      computeGateVersion(),
      this.pointerStore.readPointer(),
    ]);
    const caseResults: ValidationCaseResult[] = [];

    for (const validationCase of this.corpus) {
      const baseline = await this.execute(validatedAgainst, validationCase.session);
      const candidateOutcome = await this.execute(candidate, validationCase.session);
      caseResults.push({
        name: validationCase.name,
        mandatoryCanary: validationCase.mandatoryCanary,
        baseline: recordOutcome(baseline),
        candidate: recordOutcome(candidateOutcome),
      });
    }

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
    return { result, attestation: undefined };
  }
}

function validateCorpus(corpus: readonly ValidationCase[]): void {
  const names = new Set<string>();
  for (const validationCase of corpus) {
    if (validationCase.name.length === 0) {
      throw new TypeError("validation case name must not be empty");
    }
    if (names.has(validationCase.name)) {
      throw new TypeError(`duplicate validation case ${JSON.stringify(validationCase.name)}`);
    }
    names.add(validationCase.name);
  }
}

function recordOutcome(outcome: ReplayOutcome): RecordedCaseOutcome {
  switch (outcome.status) {
    case "PASS":
      return { status: "PASS" };
    case "FAIL": {
      const difference: EffectsDifference = outcome.difference;
      return { status: "FAIL", difference };
    }
    case "INCONCLUSIVE": {
      const inconclusive: {
        readonly status: "INCONCLUSIVE";
        readonly reason: ReplayInconclusiveReason;
        readonly detail: string;
      } = {
        status: "INCONCLUSIVE",
        reason: outcome.reason,
        detail: outcome.detail,
      };
      return inconclusive;
    }
    default:
      return assertNever(outcome, "replay outcome");
  }
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
    if (
      caseResult.baseline.status === "PASS" &&
      caseResult.candidate.status === "FAIL"
    ) {
      return "fail";
    }
  }
  return "pass";
}

export type { EffectsDifference, ReplaySession };
