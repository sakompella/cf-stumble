/**
 * Generation records and the evidence required to promote one.
 *
 * A generation is a git commit: its tree is the module manifest, its parent is the generation
 * it was derived from, so lineage is the commit DAG and costs us nothing to maintain
 * (docs/decisions.md D8).
 */

import type { Sha } from "../git/types.js";

declare const generationNumberBrand: unique symbol;

/** Position in the lineage. Generation 0 is the pinned genesis and is never collectable. */
export type GenerationNumber = number & { readonly [generationNumberBrand]: true };

export function isGenerationNumber(value: number): value is GenerationNumber {
  return Number.isInteger(value) && value >= 0;
}

export function parseGenerationNumber(value: number): GenerationNumber {
  if (!isGenerationNumber(value)) {
    throw new RangeError(`generation number must be a non-negative integer, got ${value}`);
  }
  return value;
}

export const GENESIS_NUMBER: GenerationNumber = parseGenerationNumber(0);

/** A module as authored, before it becomes a content-addressed blob. */
export type Module = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

export type Generation = {
  readonly sha: Sha;
  readonly number: GenerationNumber;
  /** Absent only for generation 0. */
  readonly parent: Sha | undefined;
  /** Tree sha — the manifest of modules making up this generation. */
  readonly manifest: Sha;
  readonly createdAt: number;
  /** Human-facing summary; lives in the commit message so `git log` shows it (D7). */
  readonly summary: string;
};

export type Verdict = "pass" | "fail" | "inconclusive";

/**
 * Evidence that a candidate was validated, bound tightly enough that it cannot be replayed
 * against a world that has since moved (D16b).
 *
 * Without `validatedAgainst`, "this candidate passed" degrades to "this candidate passed at
 * some point, against something" — and a promoter could present validation performed against a
 * generation that is no longer live. The corpus and gate versions close the same gap for the
 * case where the tests themselves changed underneath the result.
 */
export type Attestation = {
  readonly candidate: Sha;
  readonly validatedAgainst: Sha | undefined;
  readonly corpusVersion: string;
  readonly gateVersion: string;
  readonly verdict: Verdict;
  readonly createdAt: number;
};

export type PromotionRejection =
  | {
      readonly kind: "pointer-moved";
      readonly expected: Sha | undefined;
      readonly actual: Sha | undefined;
    }
  | {
      readonly kind: "stale-attestation";
      readonly validatedAgainst: Sha | undefined;
      readonly liveNow: Sha | undefined;
    }
  | { readonly kind: "corpus-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "gate-changed"; readonly attested: string; readonly current: string }
  | { readonly kind: "wrong-candidate"; readonly attested: Sha; readonly requested: Sha }
  | { readonly kind: "not-passing"; readonly verdict: Verdict };

export type PromotionResult =
  | { readonly outcome: "promoted"; readonly from: Sha | undefined; readonly to: Sha }
  | { readonly outcome: "rejected"; readonly reason: PromotionRejection };
