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

/**
 * An Access JWT, which the GitHub-shaped redaction does not recognize. Nothing should pass one to
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

function causeText(cause: unknown, knownToken: string | undefined): string {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);

    return redactLogText(message, knownToken).slice(0, CAUSE_TEXT_LIMIT);
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
    return redactLogText(value).slice(0, FIELD_TEXT_LIMIT);
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

/** How often a Workspace Host RPC reports that it is still waiting. */
const WORKSPACE_RPC_WATCH_INTERVAL_MS = 30_000;

/**
 * Measure one Supervisor-side Workspace Host RPC and make a long wait visible. The warning timer
 * belongs to this call, so a settled RPC clears it before it can report again. `timeoutMs` bounds
 * a step whose container command cannot be interrupted by an AbortSignal; the underlying RPC still
 * owns that command and is expected to stop at the same command ceiling.
 */
export async function timedWorkspaceRpc<T>(
  fields: LogFields,
  run: () => Promise<T>,
  classify: (value: T) => TimedOutcome,
  timeoutMs?: number,
): Promise<T> {
  const startedAt = Date.now();
  const logged = timeoutMs === undefined ? fields : { ...fields, timeoutMs };

  const waitingTimer = setInterval(() => {
    logEvent("warn", "workspace.rpc-waiting", {
      ...logged,
      elapsedMs: Date.now() - startedAt,
    });
  }, WORKSPACE_RPC_WATCH_INTERVAL_MS);

  try {
    return await timed("workspace.rpc", logged, () => boundedRpc(run, timeoutMs), classify);
  } finally {
    clearInterval(waitingTimer);
  }
}

type WorkspaceAnswer =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: Readonly<{ code: string }> }>;

/** Log a Workspace Host answer as `ok`, or as its problem code at warn level. */
export function classifyWorkspaceAnswer(answered: WorkspaceAnswer): TimedOutcome {
  return answered.ok ? { outcome: "ok" } : { outcome: answered.error.code, level: "warn" };
}

async function boundedRpc<T>(run: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  const operation = run();

  // Promise.race observes this rejection, but keep a handler on the original RPC too: a remote
  // call may reject after the timeout winner has already settled the race.
  void operation.catch(() => {});

  if (timeoutMs === undefined) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Workspace Host RPC timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/*
 * Request ids. One id names an owner API request across the events it caused.
 */

declare const requestIdBrand: unique symbol;

/**
 * Names one owner API request in the operational log, so the events it caused can be found with
 * one filter. The Worker generates it; no header, query, or body field can supply one.
 */
export type RequestId = string & { readonly [requestIdBrand]: never };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function newRequestId(): RequestId {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a fresh UUID is the only value this brand admits besides `parseRequestId`.
  return crypto.randomUUID() as RequestId;
}

/**
 * Accept a request id that crossed an RPC boundary, or `undefined`. A caller that sends anything
 * else loses the correlation; it never loses the operation.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- RPC input is untrusted.
export function parseRequestId(value: unknown): RequestId | undefined {
  // SAFETY: the pattern proves the brand, so only a generated-looking UUID is asserted.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, typescript/no-unsafe-type-assertion -- Boundary: the RPC payload is untrusted.
  return typeof value === "string" && UUID_PATTERN.test(value) ? (value as RequestId) : undefined;
}

/** The `requestId` log field, or no field when the call carries none. */
export function requestIdFields(requestId: RequestId | undefined): LogFields {
  return requestId === undefined ? {} : { requestId };
}
