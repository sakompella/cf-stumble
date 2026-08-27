/**
 * The two ways reading git data back can fail, as tagged errors.
 *
 * They are separate classes because they have different dispositions. An invalid object id is
 * something a request can contain, so it is recoverable and maps to a 400. Malformed object bytes
 * can only come from this encoder or from our own content-addressed store, so the caller reading
 * its own store back treats them as corruption rather than as something a user can fix — see the
 * seam in `src/generation/read.ts`.
 *
 * Decoding fails twenty-odd distinct ways and no consumer distinguishes them, so they collapse
 * into one error carrying `layer` and `condition` rather than twenty-odd classes. The fields are
 * there so a test or a log can name the condition without matching on message text; the message
 * carries the specifics.
 */

import { TaggedError } from "better-result";

/** A string offered as a SHA-1 object id was not forty lowercase hex characters. */
export class InvalidShaError extends TaggedError("InvalidShaError")<{
  value: string;
  message: string;
}> {
  constructor(args: { value: string }) {
    super({ ...args, message: `not a sha-1 object id: ${JSON.stringify(args.value)}` });
  }
}

/**
 * Which decoder rejected the bytes. `header` is the object wrapper, which is read before the
 * object's type is known; a blob body cannot fail, because it is whatever bytes follow the header.
 */
export type GitObjectDecodeLayer = "header" | "tree" | "commit";

/**
 * Why the bytes were rejected. Names are unqualified because {@link GitObjectDecodeLayer} already
 * says which decoder produced them; only `invalid-utf8` occurs at more than one layer.
 */
export type GitObjectDecodeCondition =
  // header
  | "missing-terminator"
  | "malformed-header"
  | "non-canonical-length"
  | "invalid-length"
  | "length-mismatch"
  // any layer
  | "invalid-utf8"
  // commit
  | "missing-separator"
  | "missing-header"
  | "unexpected-header"
  | "expected-header"
  | "invalid-sha"
  | "invalid-signature"
  | "invalid-identity"
  | "invalid-timestamp"
  | "invalid-timezone"
  | "non-canonical-timezone"
  // tree
  | "missing-mode-separator"
  | "invalid-mode"
  | "missing-name-terminator"
  | "invalid-name"
  | "truncated-sha"
  | "duplicate-entry-name"
  | "unsorted-entries";

export class GitObjectDecodeError extends TaggedError("GitObjectDecodeError")<{
  layer: GitObjectDecodeLayer;
  condition: GitObjectDecodeCondition;
  message: string;
  cause: unknown;
}> {
  constructor(args: {
    layer: GitObjectDecodeLayer;
    condition: GitObjectDecodeCondition;
    detail: string;
    cause?: unknown;
  }) {
    super({
      layer: args.layer,
      condition: args.condition,
      cause: args.cause,
      message: `malformed git ${args.layer} (${args.condition}): ${args.detail}`,
    });
  }
}
