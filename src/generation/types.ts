/**
 * Commit snapshots and the evidence required to promote a materialization attempt.
 *
 * Commits carry module content and commit ancestry. Generation numbers belong to the registry,
 * not to this content-addressed layer.
 */

import { Result, type Result as ResultType } from "better-result";
import { isSha } from "../git/types.js";
import type { Sha, Signature } from "../git/types.js";
import { InvalidGenerationInputError, InvalidGenerationNumberError } from "./errors.js";
import type { BuildGenerationOptions } from "./build.js";

declare const generationNumberBrand: unique symbol;

/** A registry-assigned generation number; it is not derived from commit ancestry. */
export type GenerationNumber = number & { readonly [generationNumberBrand]: true };

export function isGenerationNumber(value: number): value is GenerationNumber {
  return Number.isInteger(value) && value >= 0;
}

/** Narrow a request value into a generation number without trusting its provenance. */
export function parseGenerationNumberResult(
  value: number,
): Result<GenerationNumber, InvalidGenerationNumberError> {
  if (isGenerationNumber(value)) {
    return Result.ok(value);
  }
  return Result.err(new InvalidGenerationNumberError({ value }));
}

/**
 * Re-parse a value that came from supervisor-owned state. A rejected number means a corrupt row
 * or broken counter, neither of which a request can repair. Request parsers use
 * {@link parseGenerationNumberResult} instead.
 */
export function parseGenerationNumber(value: number): GenerationNumber {
  return parseGenerationNumberResult(value).unwrap(
    `supervisor state contains an invalid generation number: ${value}`,
  );
}

export const GENESIS_NUMBER: GenerationNumber = parseGenerationNumber(0);

/** A module as authored, before it becomes a content-addressed blob. */
export type Module = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

/** The commit metadata needed to inspect its manifest and ancestry. */
export type CommitSnapshot = {
  readonly sha: Sha;
  readonly parent: Sha | undefined;
  /** Tree sha — the manifest of modules contained in this commit. */
  readonly manifest: Sha;
  readonly createdAt: number;
  /** Human-facing summary; lives in the commit message so `git log` shows it (D7). */
  readonly summary: string;
};

/** Validate untrusted candidate input before it is encoded into a generation. */
export function validateBuildGenerationOptions(
  options: BuildGenerationOptions,
): ResultType<null, InvalidGenerationInputError> {
  if (!Number.isSafeInteger(options.createdAt)) {
    return Result.err(invalidInput("invalid-created-at", "createdAt must be a safe integer"));
  }
  const author = validateSignature(options.author, "author");
  if (Result.isError(author)) {
    return author;
  }
  const committer = makeGenerationCommitter(options);
  const validCommitter = validateSignature(committer, "committer");
  if (Result.isError(validCommitter)) {
    return validCommitter;
  }
  if (committer.timestamp !== options.createdAt) {
    return Result.err(
      invalidInput("created-at-mismatch", "createdAt must equal committer timestamp"),
    );
  }
  if (options.parent !== undefined && !isValidParent(options.parent)) {
    return Result.err(invalidInput("invalid-parent", "commit parent contains an invalid sha"));
  }
  for (const module of options.modules) {
    if (!(module.content instanceof Uint8Array)) {
      return Result.err(
        invalidInput(
          "invalid-module-content",
          `module content must be bytes for ${JSON.stringify(module.path)}`,
        ),
      );
    }
    const path = validateGenerationModulePath(module.path);
    if (Result.isError(path)) {
      return path;
    }
  }
  return Result.ok(null);
}

export function validateGenerationModulePath(
  path: string,
): ResultType<readonly string[], InvalidGenerationInputError> {
  if (path.length === 0) {
    return invalidModulePath(path, "must not be empty");
  }
  if (path.startsWith("/")) {
    return invalidModulePath(path, "must be relative");
  }
  if (path.includes("\0")) {
    return invalidModulePath(path, "must not contain NUL");
  }

  const parts = path.split("/");
  for (const part of parts) {
    if (part.length === 0) {
      return invalidModulePath(path, "contains an empty segment");
    }
    if (part === "..") {
      return invalidModulePath(path, "must not contain '..'");
    }
    if (part === ".") {
      return invalidModulePath(path, "must not contain '.'");
    }
  }
  return Result.ok(parts);
}

export function makeGenerationCommitter(options: BuildGenerationOptions): Signature {
  return (
    options.committer ?? {
      name: options.author.name,
      email: options.author.email,
      timestamp: options.createdAt,
      timezoneOffsetMinutes: options.author.timezoneOffsetMinutes,
    }
  );
}

function validateSignature(
  value: Signature,
  label: "author" | "committer",
): ResultType<null, InvalidGenerationInputError> {
  const condition = label === "author" ? "invalid-author" : "invalid-committer";
  const invalidIdentity =
    value.name.length === 0 ||
    /[\r\n<>]/u.test(value.name) ||
    value.email.length === 0 ||
    /[\r\n<>]/u.test(value.email);
  if (invalidIdentity) {
    return Result.err(invalidInput(condition, `${label} has an invalid identity`));
  }
  if (!Number.isSafeInteger(value.timestamp)) {
    return Result.err(invalidInput(condition, `${label} timestamp must be a safe integer`));
  }
  if (
    !Number.isSafeInteger(value.timezoneOffsetMinutes) ||
    value.timezoneOffsetMinutes < -1439 ||
    value.timezoneOffsetMinutes > 1439
  ) {
    return Result.err(invalidInput(condition, `${label} timezone is out of range`));
  }
  return Result.ok(null);
}

function isValidParent(parent: CommitSnapshot): boolean {
  return (
    isSha(parent.sha) &&
    isSha(parent.manifest) &&
    (parent.parent === undefined || isSha(parent.parent))
  );
}

function invalidModulePath(
  path: string,
  requirement: string,
): ResultType<never, InvalidGenerationInputError> {
  return Result.err(
    invalidInput("invalid-module-path", `module path ${requirement}: ${JSON.stringify(path)}`),
  );
}

function invalidInput(
  condition: InvalidGenerationInputError["condition"],
  detail: string,
): InvalidGenerationInputError {
  return new InvalidGenerationInputError({ condition, detail });
}

export type Verdict = "pass" | "fail" | "inconclusive";

/**
 * Evidence that a candidate was validated, bound tightly enough that it cannot be replayed
 * against a world that has since moved (D16b).
 *
 * Without the baseline identity, "this candidate passed" degrades to "this candidate passed at
 * some point, against something" — and a promoter could present validation performed against a
 * generation that is no longer live. The candidate generation and artifact digest bind the
 * attempt and bytes that ran, while the corpus and gate versions close the same gap for the case
 * where the tests themselves changed underneath the result.
 */
export type Attestation = {
  readonly candidate: Sha;
  /** The registry attempt whose artifact was validated. */
  readonly generation: GenerationNumber;
  /** Digest of the agent artifact actually loaded into the candidate facet. */
  readonly artifactDigest: Sha;
  readonly validatedAgainst: Sha | undefined;
  /** The registry generation whose commit was used as the validation baseline. */
  readonly validatedAgainstGeneration: GenerationNumber | undefined;
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
