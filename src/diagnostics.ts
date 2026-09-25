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
 *
 * The same module owns the structured operational log (`logEvent`, `timed`). A structured event
 * is one plain object per console call, so Workers Logs indexes each field and an operator can
 * filter on `event`, `projectId`, or `outcome` instead of matching prose. Its fields are ids,
 * names, codes, counts, byte sizes, and durations; `docs/agents/design/observability.md` lists
 * every event.
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

/** A value one structured log field may hold. There is no field type for free text or objects. */
export type LogValue = string | number | boolean | null;

export type LogFields = Readonly<Record<string, LogValue>>;

export type LogLevel = "info" | "warn" | "error";

/** Every string field is an id, a name, or a code, so anything longer than this is a mistake. */
const FIELD_TEXT_LIMIT = 200;

/**
 * An Access JWT, which the GitHub-shaped redaction does not recognize. Nothing should pass one to
 * a log field; this is the last line if something does.
 */
const JWT_PATTERN = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/gu;

/** The keys the logger writes itself. A field of the same name is dropped, not merged. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["event", "level", "ts"]);

const WRITERS = {
  info: (entry: LogFields) => {
    console.log(entry);
  },
  warn: (entry: LogFields) => {
    console.warn(entry);
  },
  error: (entry: LogFields) => {
    console.error(entry);
  },
} as const satisfies Record<LogLevel, (entry: LogFields) => void>;

function isText(value: LogValue): value is string {
  return typeof value === "string";
}

function logValue(value: LogValue): LogValue {
  if (!isText(value)) return value;

  try {
    return redactCredentials(value).replaceAll(JWT_PATTERN, REDACTED).slice(0, FIELD_TEXT_LIMIT);
  } catch {
    return UNPRINTABLE_CAUSE;
  }
}

/**
 * Write one structured operational event: `event` is a stable dotted name, and `fields` carry
 * only what an operator filters or aggregates on. Every string field is redacted and bounded
 * here, so a caller cannot leak a credential through a code it built from tool output.
 *
 * Keep this out of per-frame and per-byte paths: an event describes a step, not a stream.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const caller = Object.entries(fields)
    .filter(([key]) => !RESERVED_KEYS.has(key))
    .map(([key, value]) => [key, logValue(value)] as const);

  WRITERS[level]({ event, level, ts: new Date().toISOString(), ...Object.fromEntries(caller) });
}

/** A commit as the log names it: the prefix `git` itself abbreviates to, long enough to be unique. */
export function logCommit(commit: string): string {
  return commit.slice(0, 12);
}

/** How a measured step ended: its outcome code, the level to log it at, and any extra fields. */
export type TimedOutcome = Readonly<{
  outcome: string;
  level?: LogLevel;
  fields?: LogFields;
}>;

/**
 * Run one step and log its `outcome` and `durationMs` as `event`. A step that rejects is logged
 * at error level as `threw` and the rejection is rethrown unchanged; its cause is the caller's to
 * log with {@link logRedactedCause}, because only the caller knows which secret it might echo.
 */
export async function timed<T>(
  event: string,
  fields: LogFields,
  run: () => Promise<T>,
  classify: (value: T) => TimedOutcome,
): Promise<T> {
  const startedAt = Date.now();
  let value: T;

  try {
    value = await run();
  } catch (cause) {
    logEvent("error", event, {
      ...fields,
      outcome: "threw",
      timeout: isTimeoutFailure(cause),
      durationMs: Date.now() - startedAt,
    });

    throw cause;
  }

  const classified = classify(value);
  logEvent(classified.level ?? "info", event, {
    ...fields,
    ...classified.fields,
    outcome: classified.outcome,
    durationMs: Date.now() - startedAt,
  });

  return value;
}
