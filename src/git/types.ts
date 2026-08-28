/**
 * Git object model types.
 *
 * We keep git's exact on-disk object format (see ADR-0009 and ADR-0011). That is not
 * nostalgia: it makes the real `git` binary an independent oracle in tests, so an encoding
 * bug shows up as a hash mismatch against a tool we did not write.
 */

import { Result, panic } from "better-result";
import { InvalidShaError } from "./errors.js";

declare const shaBrand: unique symbol;

/** A SHA-1 object id: 40 lowercase hex characters. Construct via {@link parseShaResult}. */
export type Sha = string & { readonly [shaBrand]: true };

export const SHA_HEX_LENGTH = 40;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function isSha(value: string): value is Sha {
  return SHA_PATTERN.test(value);
}

/**
 * Narrow an untrusted string into a {@link Sha}.
 *
 * The brand comes from {@link isSha}, a type predicate, so no assertion is involved (ADR-0015).
 * This is the entry point for anything whose provenance is a request body, a URL segment, or bytes
 * read off the wire — every one of those can legitimately carry a string that is not an object id,
 * and the caller decides what to say about it.
 */
export function parseShaResult(value: string): Result<Sha, InvalidShaError> {
  if (isSha(value)) {
    return Result.ok(value);
  }
  return Result.err(new InvalidShaError({ value }));
}

/**
 * Re-parse a string that is already known to be an object id, throwing if it is not.
 *
 * This is a defect path, not a boundary: every remaining caller either builds the hex itself from
 * a twenty-byte digest ({@link "./hash.js"}, `src/storage/`) or reads back a column the supervisor
 * wrote from a {@link Sha} it already held. A throw here means the digest formatter is wrong or
 * the store is corrupt, and neither is something the caller can report and continue from. Use
 * {@link parseShaResult} for anything a request or a decoder supplies.
 *
 * The throw stays a `TypeError` rather than becoming a `panic` because one caller —
 * `parseShaField` in `src/supervisor/supervisor.ts` — still catches it to build a 400. Slice 8
 * moves that caller to {@link parseShaResult}, after which this can panic instead.
 */
export function parseSha(value: string): Sha {
  if (!isSha(value)) {
    throw new TypeError(`not a sha-1 object id: ${JSON.stringify(value)}`);
  }
  return value;
}

export type GitObjectType = "blob" | "tree" | "commit";

/**
 * Git tree entry modes. Git stores these unpadded, so a directory is "40000" and not
 * "040000" — a padding bug here changes the tree hash, which is exactly the kind of mistake
 * the `git hash-object` cross-check is there to catch.
 */
export type FileMode = "100644" | "100755" | "120000" | "40000";

export const FILE_MODE = {
  regular: "100644",
  executable: "100755",
  symlink: "120000",
  tree: "40000",
} as const satisfies Record<string, FileMode>;

export type TreeEntry = {
  readonly mode: FileMode;
  readonly name: string;
  readonly sha: Sha;
};

export type Signature = {
  readonly name: string;
  readonly email: string;
  /** Seconds since the Unix epoch. */
  readonly timestamp: number;
  /** Offset from UTC in minutes; east of UTC is positive, matching git's `+0530`. */
  readonly timezoneOffsetMinutes: number;
};

export type Commit = {
  readonly tree: Sha;
  readonly parents: readonly Sha[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
};

export type GitObject =
  | { readonly type: "blob"; readonly data: Uint8Array }
  | { readonly type: "tree"; readonly entries: readonly TreeEntry[] }
  | { readonly type: "commit"; readonly commit: Commit };

export function assertNever(value: never, context: string): never {
  panic(`${context}: unexpected variant ${JSON.stringify(value)}`);
}
