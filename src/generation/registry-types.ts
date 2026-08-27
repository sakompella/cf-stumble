/**
 * The generation registry: attempts to materialize a facet, and the record of what was live.
 *
 * See docs/agents/design/generations.md. The essential split is that a generation is an immutable *attempt*
 * while promotion and rollback are repeatable *activations*, so they cannot share one status
 * field — a validated generation may be promoted, superseded, rolled back to, and promoted
 * again.
 */

import type { Sha } from "../git/types.js";
import type { GenerationNumber } from "./types.js";

/**
 * Terminal outcomes of trying to materialize one facet. Not a linear lifecycle: `load_failed`
 * and `validation_failed` are ends, not stages on the way to `validated`.
 */
export type MaterializationState =
  | "loading"
  | "load_failed"
  | "loaded"
  | "validation_failed"
  | "validated";

export function isTerminalState(state: MaterializationState): boolean {
  return state === "load_failed" || state === "validation_failed" || state === "validated";
}

/**
 * One attempt. The number is allocated and this row written *before* the loader runs, so a
 * crash mid-load leaves evidence rather than a gap in the sequence.
 */
export type GenerationRecord = {
  readonly number: GenerationNumber;
  /** The ordinary commit this attempt was made from. Many generations may share one commit. */
  readonly commit: Sha;
  /** The live generation this candidate was built against. Counter order is not ancestry. */
  readonly baseline: GenerationNumber | undefined;
  readonly state: MaterializationState;
  /**
   * Digest of the artifact actually loaded, once known. The generation number distinguishes
   * attempts; only this proves which bytes ran.
   */
  readonly artifactDigest: Sha | undefined;
  /** Guards against a Durable Object retry silently allocating a second number. */
  readonly idempotencyKey: string;
  readonly createdAt: number;
  /** Present only for `load_failed` and `validation_failed`, naming what went wrong. */
  readonly failure: string | undefined;
};

export type ActivationKind = "promoted" | "rolled_back";

/** Append-only. Records what was live when, which a mutable generation status cannot express. */
export type ActivationEvent = {
  readonly sequence: number;
  readonly kind: ActivationKind;
  readonly generation: GenerationNumber;
  readonly from: GenerationNumber | undefined;
  readonly at: number;
};

export type AllocationRequest = {
  readonly commit: Sha;
  readonly baseline: GenerationNumber | undefined;
  readonly idempotencyKey: string;
  readonly createdAt: number;
};

export type ActivationRejection =
  | { readonly kind: "unknown-generation"; readonly generation: GenerationNumber }
  | { readonly kind: "not-validated"; readonly state: MaterializationState }
  | { readonly kind: "never-promoted"; readonly generation: GenerationNumber }
  | {
      readonly kind: "pointer-moved";
      readonly expected: GenerationNumber | undefined;
      readonly actual: GenerationNumber | undefined;
    }
  | { readonly kind: "quarantined"; readonly generation: GenerationNumber };

export type ActivationResult =
  | {
      readonly outcome: "activated";
      readonly from: GenerationNumber | undefined;
      readonly to: GenerationNumber;
    }
  | { readonly outcome: "rejected"; readonly reason: ActivationRejection };
