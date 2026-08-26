import type { Verdict } from "../generation/types.js";
import type { GenerationNumber } from "../generation/types.js";
import type { Sha } from "../git/types.js";
import type { EffectsDifference } from "../replay/comparison.js";
import type { ReplayInconclusiveReason, ReplayOutcome } from "../replay/runner.js";
import type { ReplaySession } from "../replay/schema.js";

export type ValidationCase = {
  readonly name: string;
  readonly session: ReplaySession;
  /**
   * Legacy corpus metadata. ValidationGate only treats its supervisor-owned pinned canary set
   * as authoritative for mandatory status.
   */
  readonly mandatoryCanary: boolean;
};

/** A canary definition held outside the mutable validation corpus. */
export type PinnedCanary = {
  readonly name: string;
  readonly session: ReplaySession;
};

export type ValidationExecutor = (
  generation: Sha | undefined,
  session: ReplaySession,
) => Promise<ReplayOutcome>;

export type RecordedCaseOutcome =
  | { readonly status: "PASS" }
  | { readonly status: "FAIL"; readonly difference: EffectsDifference }
  | {
      readonly status: "INCONCLUSIVE";
      readonly reason: ReplayInconclusiveReason;
      readonly detail: string;
    };

export type ValidationCaseResult = {
  readonly name: string;
  readonly mandatoryCanary: boolean;
  readonly baseline: RecordedCaseOutcome;
  readonly candidate: RecordedCaseOutcome;
};

/** The durable row for one materialization attempt, keyed by {@link generation}. */
export type ValidationResult = {
  readonly candidate: Sha;
  readonly generation: GenerationNumber;
  readonly artifactDigest: Sha;
  readonly validatedAgainst: Sha | undefined;
  readonly validatedAgainstGeneration: GenerationNumber | undefined;
  readonly corpusVersion: string;
  readonly gateVersion: string;
  readonly verdict: Verdict;
  readonly createdAt: number;
  readonly caseResults: readonly ValidationCaseResult[];
};

export type ValidationResultQuery = {
  readonly generation?: GenerationNumber;
  readonly candidate?: Sha;
  readonly verdict?: Verdict;
};

/** Storage for structured gate results; the generation number is the record key. */
export interface ValidationResultStore {
  put(result: ValidationResult): Promise<void>;
  get(generation: GenerationNumber): Promise<ValidationResult | undefined>;
  query(query?: ValidationResultQuery): Promise<readonly ValidationResult[]>;
}

export class MemoryValidationResultStore implements ValidationResultStore {
  private readonly results = new Map<GenerationNumber, ValidationResult>();

  put(result: ValidationResult): Promise<void> {
    this.results.set(result.generation, result);
    return Promise.resolve();
  }

  get(generation: GenerationNumber): Promise<ValidationResult | undefined> {
    return Promise.resolve(this.results.get(generation));
  }

  query(query: ValidationResultQuery = {}): Promise<readonly ValidationResult[]> {
    const results = [...this.results.values()].filter((result) => {
      if (query.generation !== undefined && result.generation !== query.generation) {
        return false;
      }
      if (query.candidate !== undefined && result.candidate !== query.candidate) {
        return false;
      }
      return query.verdict === undefined || result.verdict === query.verdict;
    });
    return Promise.resolve(results);
  }
}
