/**
 * A thrown effect failure never reaches its caller unexplained. `execute*` and `ask` shells
 * across the workspace and artifact boundaries catch whatever their operation threw and answer
 * with one of a few stable, public codes (ADR-0035): a token-install RPC failure and a filesystem
 * failure both become `workspace-unavailable`, and a caller cannot and should not tell them apart.
 * An operator still needs to, so this module gives every one of those catch blocks one line that
 * logs the cause it just discarded, redacted the same way any other text `git` or `gh` printed is
 * redacted (ADR-0039's workspace is the only place a credential legitimately exists, and a log is
 * not part of it).
 *
 * Redaction alone still cannot know a caller's own secret is opaque prose rather than one of
 * GitHub's documented token shapes, so a caller that is holding a specific value the cause might
 * echo passes it as `knownToken` and this module strips that exact value first.
 */
import { redactCredentials } from "./github/index.js";

/** How much of a redacted cause reaches the log. Long enough to diagnose, short enough to bound. */
const CAUSE_TEXT_LIMIT = 400;

/** A DOMException from `AbortSignal.timeout` names itself; ordinary prose says "timed out". */
const TIMEOUT_MESSAGE_PATTERN = /\btime(?:d)?[ -]?out\b/iu;

/**
 * Whether a thrown effect failure looks like the operation's own deadline rather than the
 * workspace, its container, or the RPC path to it failing outright. This is a hint for an
 * operator reading the log, not a new public result code: every caller still returns the one
 * generic code it always did.
 */
export function isTimeoutFailure(cause: unknown): boolean {
  try {
    if (!(cause instanceof Error)) return false;

    return cause.name === "TimeoutError" || TIMEOUT_MESSAGE_PATTERN.test(cause.message);
  } catch {
    return false;
  }
}

/** The fixed fallback logged when rendering a thrown cause itself throws. */
const UNPRINTABLE_CAUSE = "[unprintable cause]";

function causeText(cause: unknown, knownToken: string | undefined): string {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);

    return redactCredentials(message, knownToken).slice(0, CAUSE_TEXT_LIMIT);
  } catch {
    return UNPRINTABLE_CAUSE;
  }
}

/**
 * Log one thrown effect failure for operators. `context` names the surface, the operation, and
 * the outcome the caller is about to return publicly, e.g.
 * `"github-credential.install: workspace-unavailable"`; the cause itself is always redacted
 * before it reaches `console.error`, and `knownToken`, when the caller is holding one, is
 * stripped first so an opaque value redaction's fixed patterns would not recognize still cannot
 * reach the log.
 */
export function logRedactedCause(context: string, cause: unknown, knownToken?: string): void {
  console.error(`${context}: ${causeText(cause, knownToken)}`);
}
