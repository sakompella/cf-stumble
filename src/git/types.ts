/**
 * Git object model types.
 *
 * We keep git's exact on-disk object format (see docs/decisions.md D1, D4). That is not
 * nostalgia: it makes the real `git` binary an independent oracle in tests, so an encoding
 * bug shows up as a hash mismatch against a tool we did not write.
 */

declare const shaBrand: unique symbol;

/** A SHA-1 object id: 40 lowercase hex characters. Construct via {@link parseSha}. */
export type Sha = string & { readonly [shaBrand]: true };

export const SHA_HEX_LENGTH = 40;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function isSha(value: string): value is Sha {
  return SHA_PATTERN.test(value);
}

/** Parse untrusted input into a {@link Sha}, throwing if it is not one. */
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
  throw new Error(`${context}: unexpected variant ${JSON.stringify(value)}`);
}
