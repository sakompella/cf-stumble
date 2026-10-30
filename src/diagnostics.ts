/**
 * A thrown effect failure never reaches its caller unexplained. `execute*` and `ask` shells
 * across the workspace and artifact boundaries catch whatever their operation threw and answer
 * with one of a few stable, public codes (ADR-0045): a token-install RPC failure and a filesystem
 * failure both become `workspace-unavailable`, and a caller cannot and should not tell them apart.
 * An operator still needs to, so this module gives every one of those catch blocks one line that
 * logs the cause it just discarded, redacted the same way any other text `git` or `gh` printed is
 * redacted (ADR-0039's workspace is the only place a credential legitimately exists, and a log is
 * not part of it).
 *
 * Redaction alone still cannot know a caller's own secret is opaque prose rather than one of
 * GitHub's documented token shapes, so a caller that is holding a specific value the cause might
 * echo passes it as `knownToken` and this module strips that exact value first.
 *
 * The same module owns `logEvent`, the structured operational log;
 * `docs/agents/design/observability.md` lists every event.
 */
import { REDACTED, redactCredentials } from "./github/index.js";

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

/**
 * A JWT, which the GitHub-shaped redaction does not recognize. Nothing should pass one to
 * a log; this pattern is the last defense if something does.
 */
const JWT_PATTERN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/gu;

/**
 * Every pattern the log recognizes, applied to whole text. Callers cut only after this runs:
 * cutting first can leave a token's header and claims without the rest the pattern needs.
 */
export function redactLogText(text: string, knownToken?: string): string {
  return redactCredentials(text, knownToken).replaceAll(JWT_PATTERN, REDACTED);
}

/** Redact text with every log pattern, then cut it to the length a logged cause may have. */
export function redactedExcerpt(text: string, knownToken?: string): string {
  return redactLogText(text, knownToken).slice(0, CAUSE_TEXT_LIMIT);
}

function causeText(cause: unknown, knownToken: string | undefined): string {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);

    return redactedExcerpt(message, knownToken);
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

/** A value one structured log field may hold. There is no field type for free text or objects. */
type LogValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, LogValue>>;

export type LogLevel = "info" | "warn" | "error";

/** Every string field is an id, a name, or a code, so anything longer than this is a mistake. */
const FIELD_TEXT_LIMIT = 200;

const CONSOLE_METHOD = { info: "log", warn: "warn", error: "error" } as const;

/**
 * Write one structured operational event as one plain object, so Workers Logs indexes each field.
 * Every string field is redacted and bounded here, so a caller cannot leak a credential through a
 * code it built from tool output. A field cannot replace `event`, `level`, or `ts`.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const redacted = Object.entries(fields).map(([key, value]) =>
    isText(value) ? [key, redactLogText(value).slice(0, FIELD_TEXT_LIMIT)] : [key, value],
  );

  console[CONSOLE_METHOD[level]]({
    ...Object.fromEntries(redacted),
    event,
    level,
    ts: new Date().toISOString(),
  });
}

function isText(value: LogValue): value is string {
  return typeof value === "string";
}
