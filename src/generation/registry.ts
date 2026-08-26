import { assertNever } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type {
  AllocationRequest,
  GenerationRecord,
  MaterializationState,
} from "./registry-types.js";
import { parseGenerationNumber } from "./types.js";
import type { GenerationNumber } from "./types.js";

export type MaterializationTransition =
  | {
      readonly state: "load_failed";
      readonly artifactDigest?: Sha;
      readonly failure: string;
    }
  | { readonly state: "loaded"; readonly artifactDigest?: Sha }
  | { readonly state: "validation_failed"; readonly failure: string }
  | { readonly state: "validated" };

export type RegistryRejection =
  | { readonly kind: "unknown-generation"; readonly generation: GenerationNumber }
  | {
      readonly kind: "illegal-transition";
      readonly from: MaterializationState;
      readonly to: MaterializationTransition["state"];
    };

export type MaterializationTransitionResult =
  | { readonly outcome: "transitioned"; readonly record: GenerationRecord }
  | { readonly outcome: "rejected"; readonly reason: RegistryRejection };

export interface GenerationRegistry {
  allocate(request: AllocationRequest): Promise<GenerationRecord>;
  get(number: GenerationNumber): Promise<GenerationRecord | undefined>;
  list(): Promise<readonly GenerationRecord[]>;
  transition(
    number: GenerationNumber,
    next: MaterializationTransition,
  ): Promise<MaterializationTransitionResult>;
}

/**
 * In-memory registry implementation. Allocation and each state transition mutate state in one
 * synchronous section, so callers observe a complete record and never a partially updated one.
 */
export class MemoryGenerationRegistry implements GenerationRegistry {
  private readonly records = new Map<GenerationNumber, GenerationRecord>();
  private readonly idempotency = new Map<string, GenerationNumber>();
  private nextNumber = 0;

  allocate(request: AllocationRequest): Promise<GenerationRecord> {
    const existingNumber = this.idempotency.get(request.idempotencyKey);
    if (existingNumber !== undefined) {
      const existing = this.records.get(existingNumber);
      if (existing === undefined) {
        throw new Error("generation idempotency index is inconsistent");
      }
      return Promise.resolve(copyRecord(existing));
    }

    if (this.nextNumber > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("generation number counter is exhausted");
    }
    const number = parseGenerationNumber(this.nextNumber);
    this.nextNumber += 1;
    const record = {
      number,
      commit: request.commit,
      baseline: request.baseline,
      state: "loading",
      artifactDigest: undefined,
      idempotencyKey: request.idempotencyKey,
      createdAt: request.createdAt,
      failure: undefined,
    } satisfies GenerationRecord;
    this.records.set(number, record);
    this.idempotency.set(request.idempotencyKey, number);
    return Promise.resolve(copyRecord(record));
  }

  get(number: GenerationNumber): Promise<GenerationRecord | undefined> {
    const record = this.records.get(number);
    return Promise.resolve(record === undefined ? undefined : copyRecord(record));
  }

  list(): Promise<readonly GenerationRecord[]> {
    return Promise.resolve([...this.records.values()].map((record) => copyRecord(record)));
  }

  transition(
    number: GenerationNumber,
    next: MaterializationTransition,
  ): Promise<MaterializationTransitionResult> {
    const current = this.records.get(number);
    if (current === undefined) {
      return Promise.resolve({
        outcome: "rejected",
        reason: { kind: "unknown-generation", generation: number },
      });
    }
    if (!isLegalTransition(current.state, next.state)) {
      return Promise.resolve({
        outcome: "rejected",
        reason: { kind: "illegal-transition", from: current.state, to: next.state },
      });
    }

    const updated = applyTransition(current, next);
    this.records.set(number, updated);
    return Promise.resolve({ outcome: "transitioned", record: copyRecord(updated) });
  }
}

export const InMemoryGenerationRegistry = MemoryGenerationRegistry;

function copyRecord(record: GenerationRecord): GenerationRecord {
  return { ...record };
}

function isLegalTransition(
  current: MaterializationState,
  next: MaterializationTransition["state"],
): boolean {
  switch (current) {
    case "loading":
      return next === "load_failed" || next === "loaded";
    case "loaded":
      return next === "validation_failed" || next === "validated";
    case "load_failed":
    case "validation_failed":
    case "validated":
      return false;
    default:
      return assertNever(current, "materialization state");
  }
}

function applyTransition(
  record: GenerationRecord,
  next: MaterializationTransition,
): GenerationRecord {
  switch (next.state) {
    case "load_failed":
      return {
        ...record,
        state: next.state,
        artifactDigest: next.artifactDigest,
        failure: next.failure,
      };
    case "loaded":
      return { ...record, state: next.state, artifactDigest: next.artifactDigest };
    case "validation_failed":
      return { ...record, state: next.state, failure: next.failure };
    case "validated":
      return { ...record, state: next.state, failure: undefined };
    default:
      return assertNever(next, "materialization transition");
  }
}
